import { ErpAuthError, ErpBusinessError, type ErpWriter } from '@seta/erp-api-tse';
import { textoVendido } from '@seta/sdr';
import { and, eq, sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import type { Logger } from 'pino';
import { type AssinaturaDeps, enviarParaAssinatura } from '../assinatura/fluxo.js';
import { FILA_ERP_VENDA } from '../boss.js';
import type { Db } from '../db/index.js';
import { erpEscrita, venda } from '../db/schema.js';
import { enqueueOutbound } from '../wa/outbox.js';
import { chaveVenda } from './chave.js';
import { escalarTicketVenda, TRIGGER_FALHA_VENDA } from './escalar.js';
import type { Comprador, VendaRow } from './repo.js';

/**
 * 045 — a venda chega ao ERP. **Três escritas encadeadas**, nesta ordem, e
 * nenhuma delas é idempotente no TSE:
 *
 *   A. `SetPessoa`  → `IdPessoa`    (o comprador)
 *   B. `setcasal`   → `IdCasal`     (o lead, via READ-BACK: o POST responde vazio)
 *   C. `SetVenda`   → `IdContrato`  (o contrato, com as parcelas)
 *
 * Cada id é gravado em `venda` assim que nasce. Uma tentativa que morre no meio
 * retoma de onde parou em vez de refazer tudo — é o que impede duas pessoas,
 * dois casais ou (o pior) dois contratos para a mesma compra.
 *
 * A guarda externa é a mesma da 036/038: `erp_escrita` em `pendente`, tirada por
 * um UPDATE condicional. Quem perde a corrida não escreve nada.
 *
 * **Nada aqui roda sem o sinal pago.** Quem enfileira este job é o evento de
 * pagamento confirmado do PSP, nunca o turno do agente e nunca o LLM.
 */

export interface VendaWorkerDeps {
  readonly db: Db;
  readonly boss: PgBoss;
  readonly writer: ErpWriter;
  readonly logger: Logger;
  /** Produto do TSE que corresponde à cota vendida — ver decisão no PR. */
  readonly idProdutoPadrao: number;
  /** Ids do espelho: 1 = ENTRADA, 2 = SALDO; 1 = BOLETO, 2 = PIX. */
  readonly idMeioPagamentoSinal: number;
  readonly idMeioPagamentoSaldo: number;
  /**
   * 046: manda o contrato para assinar, logo depois de avisar que ele foi
   * registrado. Ausente ⇒ a venda termina como na 045, no aviso — é o degrau
   * que mantém a 045 funcionando sozinha.
   */
  readonly assinatura?: AssinaturaDeps;
}

export type ResultadoVenda = 'registrada' | 'ja-resolvida' | 'falha';

export async function processarVenda(
  deps: VendaWorkerDeps,
  vendaId: string,
): Promise<ResultadoVenda> {
  const chave = chaveVenda(vendaId);
  /** Guarda: só uma execução tira a linha de `pendente`. */
  const [escrita] = await deps.db
    .update(erpEscrita)
    .set({ tentativas: sql`${erpEscrita.tentativas} + 1`, atualizadoEm: new Date() })
    .where(and(eq(erpEscrita.chave, chave), eq(erpEscrita.estado, 'pendente')))
    .returning();
  if (!escrita) {
    deps.logger.info({ chave }, 'venda já resolvida — nada a fazer no ERP');
    return 'ja-resolvida';
  }

  const [linha] = await deps.db.select().from(venda).where(eq(venda.id, vendaId));
  if (!linha) {
    await concluir(deps, chave, 'falha', 'venda inexistente');
    return 'falha';
  }

  await deps.db
    .update(venda)
    .set({ status: 'registrando', atualizadoEm: new Date() })
    .where(eq(venda.id, vendaId));

  try {
    const contratoId = await registrar(deps, linha);
    await concluir(deps, chave, 'confirmada', null, String(contratoId));
    await deps.db
      .update(venda)
      .set({
        status: 'registrada',
        erpContratoId: String(contratoId),
        atualizadoEm: new Date(),
      })
      .where(eq(venda.id, vendaId));
    await avisar(deps, linha, String(contratoId));
    await mandarAssinar(deps, linha, String(contratoId));
    deps.logger.info({ chave, contratoId }, 'venda registrada no ERP');
    return 'registrada';
  } catch (err) {
    const definitivo = err instanceof ErpAuthError || err instanceof ErpBusinessError;
    const mensagem = err instanceof Error ? err.message : String(err);
    if (!definitivo) {
      await deps.db
        .update(erpEscrita)
        .set({ erro: mensagem, atualizadoEm: new Date() })
        .where(eq(erpEscrita.chave, chave));
      // volta a `sinal_emitido`? Não: o dinheiro entrou. Fica `registrando` e o
      // pg-boss re-tenta — a venda existe, só ainda não chegou ao ERP.
      throw err;
    }
    await concluir(deps, chave, 'falha', mensagem);
    await deps.db
      .update(venda)
      .set({ status: 'falha', motivo: mensagem.slice(0, 300), atualizadoEm: new Date() })
      .where(eq(venda.id, vendaId));
    await escalarFalha(deps, linha, mensagem);
    deps.logger.error({ chave, err: mensagem }, 'venda recusada pelo ERP — escalada para humano');
    return 'falha';
  }
}

/**
 * As três escritas. Cada id é persistido no instante em que nasce: se o
 * processo cair entre B e C, a próxima tentativa não recria pessoa nem casal.
 */
async function registrar(deps: VendaWorkerDeps, linha: VendaRow): Promise<number> {
  if (linha.erpContratoId) return Number(linha.erpContratoId);
  const comprador = linha.comprador as Comprador;

  // A. pessoa
  let pessoaId = linha.erpPessoaId ? Number(linha.erpPessoaId) : null;
  if (pessoaId === null) {
    const r = await deps.writer.criarPessoa({ nome: comprador.nome, cpf: comprador.cpf });
    pessoaId = r.pessoaId;
    await deps.db
      .update(venda)
      .set({ erpPessoaId: String(pessoaId), atualizadoEm: new Date() })
      .where(eq(venda.id, linha.id));
  }

  // B. casal (lead). `criarLead` faz o read-back por CPF lá dentro — o POST do
  // TSE responde vazio e não há como saber o id de outro jeito.
  let casalId = linha.erpCasalId ? Number(linha.erpCasalId) : null;
  if (casalId === null) {
    const r = await deps.writer.criarLead({ nome: comprador.nome, cpf: comprador.cpf });
    casalId = r.casalId;
    await deps.db
      .update(venda)
      .set({ erpCasalId: String(casalId), atualizadoEm: new Date() })
      .where(eq(venda.id, linha.id));
  }

  // C. venda. O sinal já foi pago (é o que disparou este job) e entra como
  // ENTRADA; o que sobra vira uma parcela de SALDO com vencimento em 30 dias.
  const saldo = Math.max(0, linha.valorCentavos - linha.sinalCentavos);
  const { contratoId } = await deps.writer.criarVenda({
    idCasal: casalId,
    idComprador: pessoaId,
    idProduto: linha.idProduto || deps.idProdutoPadrao,
    idCotaUh: Number(linha.cotaId),
    valorCentavos: linha.valorCentavos,
    parcelas: [
      {
        idMeioPagamento: deps.idMeioPagamentoSinal,
        idTipoOrigem: 1, // ENTRADA
        vencimento: hoje(),
        valorCentavos: linha.sinalCentavos,
      },
      ...(saldo > 0
        ? [
            {
              idMeioPagamento: deps.idMeioPagamentoSaldo,
              idTipoOrigem: 2, // SALDO
              vencimento: emDias(30),
              valorCentavos: saldo,
            },
          ]
        : []),
    ],
  });
  return contratoId;
}

async function concluir(
  deps: VendaWorkerDeps,
  chave: string,
  estado: 'confirmada' | 'falha',
  erro: string | null,
  erpId?: string,
): Promise<void> {
  await deps.db
    .update(erpEscrita)
    .set({
      estado,
      erro: erro?.slice(0, 500) ?? null,
      ...(erpId ? { erpId } : {}),
      atualizadoEm: new Date(),
    })
    .where(eq(erpEscrita.chave, chave));
}

/**
 * 046: o contrato existe no ERP — agora ele vira documento e vai para
 * assinatura. Falhar aqui NÃO desfaz a venda: o dinheiro entrou e o contrato
 * está registrado. Vira ticket, e o comprador ouve o que houve.
 */
async function mandarAssinar(
  deps: VendaWorkerDeps,
  linha: VendaRow,
  contratoId: string,
): Promise<void> {
  if (!deps.assinatura) return;
  const comprador = linha.comprador as Comprador;
  try {
    const r = await enviarParaAssinatura(deps.assinatura, {
      id: linha.id,
      conversaId: linha.conversaId,
      contratoErpId: contratoId,
      compradorNome: comprador.nome,
      ...(comprador.cpf ? { compradorCpf: comprador.cpf } : {}),
    });
    if (r.estado === 'sem_documento') {
      await escalarTicketVenda(
        deps.db,
        linha.conversaId,
        TRIGGER_FALHA_VENDA,
        `contrato ${contratoId} registrado, mas o ERP não devolveu o documento para assinatura`,
        { refId: linha.id },
      );
    }
  } catch (err) {
    deps.logger.error(
      { err, vendaId: linha.id, contratoId },
      'venda: contrato registrado, mas a assinatura não foi criada',
    );
    await escalarTicketVenda(
      deps.db,
      linha.conversaId,
      TRIGGER_FALHA_VENDA,
      `contrato ${contratoId} registrado, mas a assinatura não foi criada`,
      { refId: linha.id },
    );
  }
}

async function avisar(deps: VendaWorkerDeps, linha: VendaRow, contratoId: string): Promise<void> {
  await enqueueOutbound(
    { db: deps.db, boss: deps.boss },
    {
      conversaId: linha.conversaId,
      chave: `venda:${linha.id}:registrada`,
      texto: textoVendido(contratoId),
      autor: 'bot',
    },
  );
}

async function escalarFalha(deps: VendaWorkerDeps, linha: VendaRow, motivo: string): Promise<void> {
  // o comprador PAGOU e o contrato não saiu: isso nunca pode morrer num log
  await escalarTicketVenda(
    deps.db,
    linha.conversaId,
    TRIGGER_FALHA_VENDA,
    `sinal pago mas o ERP recusou a venda (${motivo.slice(0, 160)}) — resolver com o comprador`,
    { refId: linha.id },
  );
}

function hoje(): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format(new Date());
}

function emDias(n: number): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format(
    new Date(Date.now() + n * 86_400_000),
  );
}

export function registerErpVendaWorker(deps: VendaWorkerDeps): Promise<string> {
  return deps.boss.work<{ vendaId: string }>(
    FILA_ERP_VENDA,
    { includeMetadata: true },
    async (jobs) => {
      for (const job of jobs) {
        await processarVenda(deps, job.data.vendaId);
      }
    },
  );
}
