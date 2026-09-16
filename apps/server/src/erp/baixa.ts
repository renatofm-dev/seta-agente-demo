import {
  ErpAuthError,
  ErpBusinessError,
  type ErpWriter,
  type RegistrarPagamentoInput,
} from '@seta/erp-api-tse';
import { and, eq, sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import type { Logger } from 'pino';
import { FILA_ERP_BAIXA } from '../boss.js';
import type { Db, Tx } from '../db/index.js';
import { cobranca, erpEscrita, pagamento } from '../db/schema.js';
import { escalarTicketCobranca } from '../pagamentos/escalar.js';

/**
 * 036 — a baixa de verdade no ERP. Até aqui o cotista pagava e a plataforma
 * FINGIA que o ERP sabia (`pagamentos/conciliacao.ts` reescrevia as leituras a
 * partir da tabela `pagamento`). Agora a baixa é gravada no TSE, e como a
 * leitura continua por SQL **sobre a mesma base**, a parcela aparece
 * `v_titulo.status = 'pago'` na leitura seguinte — sem esperar a 037.
 *
 * Fila separada, e não um passo dentro de `marcarPaga`, porque ali um `throw`
 * faz o evento INTEIRO reprocessar (`pagamentos/eventos.ts`) e cada retry
 * reexecutaria `notificarPago` — o cotista receberia "pagamento confirmado" N
 * vezes por causa de uma instabilidade do ERP.
 */

export const TRIGGER_FALHA_BAIXA_ERP = 'falha_baixa_erp';

/** `baixa:<pagamento.id>` — determinística, e é a PK de `erp_escrita`. */
export const chaveBaixa = (pagamentoId: string): string => `baixa:${pagamentoId}`;

export interface ErpBaixaDeps {
  readonly db: Db;
  readonly boss: PgBoss;
  readonly writer: ErpWriter;
  readonly logger: Logger;
}

export interface BaixaPendente {
  readonly pagamentoId: string;
  readonly contaFinanceiraId: string;
  readonly contratoId: string;
  readonly valorCentavos: number;
  readonly metodo: RegistrarPagamentoInput['metodo'];
  readonly referenciaPsp: string;
}

/**
 * Insere a intenção de baixa DENTRO da transação que grava `pagamento` — as
 * duas coisas nascem juntas ou não nascem. Devolve só as que realmente
 * entraram: quem já estava lá não vira job novo (o webhook do Asaas reentrega).
 */
export async function registrarBaixasPendentes(
  tx: Tx,
  entradas: readonly BaixaPendente[],
): Promise<string[]> {
  const novas: string[] = [];
  for (const e of entradas) {
    const [linha] = await tx
      .insert(erpEscrita)
      .values({
        chave: chaveBaixa(e.pagamentoId),
        operacao: 'baixa',
        alvo: e.contaFinanceiraId,
        payload: e,
      })
      .onConflictDoNothing({ target: erpEscrita.chave })
      .returning({ chave: erpEscrita.chave });
    if (linha) novas.push(e.pagamentoId);
  }
  return novas;
}

/** Enfileira DEPOIS do commit — o padrão que `registrarEventoPsp` já usa. */
export async function enfileirarBaixas(boss: PgBoss, pagamentoIds: readonly string[]) {
  for (const pagamentoId of pagamentoIds) {
    await boss.send(FILA_ERP_BAIXA, { pagamentoId });
  }
}

type Resultado = 'confirmada' | 'ja-resolvida' | 'falha' | 'read-back';

/** Valor bate com o que gravamos? Tolerância de 1 centavo (arredondamento decimal do TSE). */
function valorCompativel(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1;
}

export async function processarBaixa(deps: ErpBaixaDeps, pagamentoId: string): Promise<Resultado> {
  const chave = chaveBaixa(pagamentoId);
  /**
   * Guarda 1 — antes de falar com o TSE. Só uma execução tira a linha de
   * `pendente`; quem chega depois (reentrega do webhook, retry do pg-boss numa
   * linha já confirmada) sai por aqui sem tocar no ERP.
   */
  const [linha] = await deps.db
    .update(erpEscrita)
    .set({ tentativas: sql`${erpEscrita.tentativas} + 1`, atualizadoEm: new Date() })
    .where(and(eq(erpEscrita.chave, chave), eq(erpEscrita.estado, 'pendente')))
    .returning();
  if (!linha) {
    deps.logger.info({ chave }, 'baixa já resolvida — nada a fazer no ERP');
    return 'ja-resolvida';
  }
  const entrada = linha.payload as BaixaPendente;

  /**
   * Guarda 2 — a única defesa REAL, porque `TransacaoEletronica` quase certamente
   * não é idempotente no TSE. Na segunda tentativa em diante, pergunta ao ERP
   * antes de mandar de novo: a tentativa anterior pode ter chegado e só a
   * resposta ter se perdido.
   */
  if (linha.tentativas > 1) {
    const jaPago = await conferirNoErp(deps, entrada);
    if (jaPago) {
      // `erpId` fica nulo: a baixa existe no ERP, mas o id da transação foi
      // embora com a resposta perdida. O que importa para a conciliação é o
      // estado; o rastro no TSE é o `CodigoAutorizacao` com o id do PSP.
      await concluir(deps, chave, 'confirmada', null, null);
      deps.logger.warn(
        { chave, tentativas: linha.tentativas },
        'read-back: a parcela já estava paga no ERP — baixa NÃO repetida',
      );
      return 'read-back';
    }
  }

  try {
    const { transacaoId } = await deps.writer.registrarPagamento(entrada);
    await concluir(deps, chave, 'confirmada', transacaoId, null);
    deps.logger.info({ chave, transacaoId }, 'baixa registrada no ERP');
    return 'confirmada';
  } catch (err) {
    const definitivo = err instanceof ErpAuthError || err instanceof ErpBusinessError;
    const mensagem = err instanceof Error ? err.message : String(err);
    if (!definitivo) {
      /**
       * Timeout ou rede: a requisição PODE ter chegado. Não repetimos o POST
       * aqui — conferimos, e só o pg-boss decide re-tentar.
       */
      if (await conferirNoErp(deps, entrada)) {
        await concluir(deps, chave, 'confirmada', null, null);
        deps.logger.warn(
          { chave },
          'POST sem resposta, mas a baixa pegou — confirmada sem repetir',
        );
        return 'read-back';
      }
      await deps.db
        .update(erpEscrita)
        .set({ erro: mensagem, atualizadoEm: new Date() })
        .where(eq(erpEscrita.chave, chave));
      throw err; // pg-boss re-tenta com backoff
    }
    await concluir(deps, chave, 'falha', null, mensagem);
    await escalarBaixa(deps, entrada, mensagem);
    deps.logger.error({ chave, err: mensagem }, 'baixa recusada pelo ERP — escalada para humano');
    return 'falha';
  }
}

/** O read-back propriamente dito. Erro aqui NÃO decide nada: devolve `false`. */
async function conferirNoErp(deps: ErpBaixaDeps, e: BaixaPendente): Promise<boolean> {
  try {
    const parcela = await deps.writer.lerParcela(e.contaFinanceiraId, e.contratoId);
    return parcela?.pago === true && valorCompativel(parcela.valorCentavos, e.valorCentavos);
  } catch (err) {
    deps.logger.warn(
      { alvo: e.contaFinanceiraId, err: err instanceof Error ? err.message : err },
      'read-back falhou — seguindo como não confirmada',
    );
    return false;
  }
}

async function concluir(
  deps: ErpBaixaDeps,
  chave: string,
  estado: 'confirmada' | 'falha',
  erpId: string | null,
  erro: string | null,
) {
  await deps.db
    .update(erpEscrita)
    .set({ estado, erpId, erro, atualizadoEm: new Date() })
    .where(eq(erpEscrita.chave, chave));
}

/** Baixa que falha vira ticket, nunca silêncio — o cotista pagou de verdade. */
async function escalarBaixa(deps: ErpBaixaDeps, e: BaixaPendente, motivo: string) {
  const [linha] = await deps.db
    .select({ conversaId: cobranca.conversaId })
    .from(pagamento)
    .innerJoin(cobranca, eq(cobranca.id, pagamento.cobrancaId))
    .where(eq(pagamento.id, e.pagamentoId));
  if (!linha) return;
  await escalarTicketCobranca(
    deps.db,
    linha.conversaId,
    TRIGGER_FALHA_BAIXA_ERP,
    `pagamento recebido mas o ERP recusou a baixa do título ${e.contaFinanceiraId}: ${motivo}`,
    { refId: e.pagamentoId },
  );
}

export async function registerErpBaixaWorker(deps: ErpBaixaDeps): Promise<void> {
  await deps.boss.work<{ pagamentoId: string }>(FILA_ERP_BAIXA, async (jobs) => {
    for (const job of jobs) await processarBaixa(deps, job.data.pagamentoId);
  });
}
