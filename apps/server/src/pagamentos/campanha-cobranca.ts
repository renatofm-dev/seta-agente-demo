import { referenciaCobranca } from '@seta/cobranca';
import type { DbConnector } from '@seta/erp-connector';
import { newTraceId } from '@seta/observability';
import { eq } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import type { Logger } from 'pino';
import { FILA_COBRANCA_EMITIR } from '../boss.js';
import type { Db } from '../db/index.js';
import { cobranca, cobrancaTitulo, conversa } from '../db/schema.js';
import type { Env } from '../env.js';
import { estaSuprimido } from '../wa/supressao.js';
import {
  type AlvoCobranca,
  carteiraInadimplente,
  type FiltroCarteira,
} from './carteira-inadimplente.js';

/**
 * 044 — cobrança ativa: a plataforma abre a conversa com quem está em atraso.
 *
 * ## O desenho, e por que ele é pequeno
 *
 * A primeira versão disto que eu esbocei era um pipeline novo: materializar
 * público, emitir em fila, preencher variável por destinatário, disparar
 * template. Errado — a 014 **já faz tudo isso**. `processarEmissao` cria a
 * cobrança no PSP, renderiza a mensagem com link e código, e põe no outbox; o
 * outbox escolhe texto livre ou template conforme a janela de 24 h (e para
 * contato proativo a janela está fechada por definição, então sai template).
 *
 * Então cobrança ativa é: para cada inadimplente da carteira, **criar a linha
 * de `cobranca` e enfileirar a emissão** — exatamente o que o fluxo faz quando
 * o cotista pede para pagar, só que iniciado pelo operador. De graça vêm o
 * dedupe por referência determinística, o retry do pg-boss, o teto de alçada,
 * o bloqueio por falta de CPF e a conciliação.
 *
 * ## Três decisões que são de produto, não de código
 *
 * 1. **Uma parcela por destinatário**, a mais antiga vencida — não todas. Com
 *    o teto em R$ 5.000, cobrar todas as vencidas jogaria quase todo mundo em
 *    `aguardando_aprovacao`, e uma campanha que para inteira na fila humana não
 *    é campanha. Uma parcela também é a primeira cobrança mais defensável:
 *    começa pela dívida mais velha.
 * 2. **Dry-run por padrão.** Sem `confirmar: true` nada é criado: devolve o
 *    público e o plano. Disparar cobrança para gente de verdade não pode ser o
 *    efeito de um clique acidental.
 * 3. **Teto de destinatários.** Campanha grande é a 030; aqui o limite é baixo
 *    de propósito, porque a emissão é inline e cada uma fala com o PSP.
 */

export const MAX_DESTINATARIOS_CAMPANHA = 50;

export interface CampanhaCobrancaDeps {
  readonly db: Db;
  readonly erp: DbConnector;
  readonly boss: PgBoss;
  readonly logger: Logger;
  readonly env: Pick<Env, 'PAGAMENTO_TETO_SEM_HITL_CENTAVOS' | 'PAGAMENTO_DIAS_VENCIMENTO'>;
  readonly pspNome: string;
}

export type MotivoRecusa = 'suprimido' | 'acima_do_teto' | 'cobranca_em_aberto';

export interface LinhaPlano {
  readonly alvo: AlvoCobranca;
  readonly recusa: MotivoRecusa | null;
}

export interface PlanoCampanha {
  readonly total: number;
  readonly cobraveis: number;
  readonly linhas: readonly LinhaPlano[];
  readonly truncadoEm: number | null;
}

const dataMaisDias = (dias: number): string => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
};

/**
 * Monta o plano SEM efeito nenhum. É o que o dry-run devolve e é o que o
 * disparo consome — a mesma função nos dois caminhos, para o que foi mostrado
 * na tela ser o que vai acontecer.
 */
export async function planejarCampanha(
  deps: CampanhaCobrancaDeps,
  filtro?: FiltroCarteira,
): Promise<PlanoCampanha> {
  const todos = await carteiraInadimplente({ db: deps.db, erp: deps.erp }, filtro);
  const truncadoEm = todos.length > MAX_DESTINATARIOS_CAMPANHA ? MAX_DESTINATARIOS_CAMPANHA : null;
  const alvos = truncadoEm ? todos.slice(0, truncadoEm) : todos;

  const linhas: LinhaPlano[] = [];
  for (const alvo of alvos) {
    let recusa: MotivoRecusa | null = null;
    if (await estaSuprimido(deps.db, alvo.waId)) {
      recusa = 'suprimido';
    } else if (alvo.parcelaValorCentavos > deps.env.PAGAMENTO_TETO_SEM_HITL_CENTAVOS) {
      // acima do teto a 014 escalaria para aprovação; numa campanha isso vira
      // fila humana sem aviso, então ele é RECUSADO aqui, visível no plano
      recusa = 'acima_do_teto';
    } else {
      const referencia = referenciaCobranca(alvo.contratoId, [alvo.parcelaTituloId]);
      const [aberta] = await deps.db
        .select({ id: cobranca.id })
        .from(cobranca)
        .where(eq(cobranca.referenciaExterna, referencia));
      // já existe cobrança para ESTA parcela: cobrar de novo seria duplicar a
      // mensagem para quem já recebeu
      if (aberta) recusa = 'cobranca_em_aberto';
    }
    linhas.push({ alvo, recusa });
  }
  return {
    total: todos.length,
    cobraveis: linhas.filter((l) => l.recusa === null).length,
    linhas,
    truncadoEm,
  };
}

export interface ResultadoCampanha {
  readonly plano: PlanoCampanha;
  readonly cobrancasCriadas: readonly string[];
}

/** Garante a conversa do wa_id SEM tocar a janela (contato proativo não abre janela). */
async function conversaDoWaId(db: Db, waId: string): Promise<string> {
  const [nova] = await db
    .insert(conversa)
    .values({ id: newTraceId(), waId })
    .onConflictDoNothing({ target: conversa.waId })
    .returning({ id: conversa.id });
  if (nova) return nova.id;
  const [existente] = await db
    .select({ id: conversa.id })
    .from(conversa)
    .where(eq(conversa.waId, waId));
  if (!existente) throw new Error(`conversa de ${waId} sumiu na corrida`);
  return existente.id;
}

/**
 * Cria a cobrança de cada alvo cobrável e enfileira a emissão. Falha em um NÃO
 * derruba os demais — mesma regra do disparo da 013.
 */
export async function dispararCampanha(
  deps: CampanhaCobrancaDeps,
  filtro?: FiltroCarteira,
): Promise<ResultadoCampanha> {
  const plano = await planejarCampanha(deps, filtro);
  const criadas: string[] = [];

  for (const { alvo, recusa } of plano.linhas) {
    if (recusa !== null) continue;
    try {
      const conversaId = await conversaDoWaId(deps.db, alvo.waId);
      const id = newTraceId();
      const referencia = referenciaCobranca(alvo.contratoId, [alvo.parcelaTituloId]);
      await deps.db.transaction(async (tx) => {
        await tx.insert(cobranca).values({
          id,
          conversaId,
          contratoId: alvo.contratoId,
          referenciaExterna: referencia,
          status: 'emitindo',
          metodo: 'boleto',
          valorCentavos: alvo.parcelaValorCentavos,
          vencimentoPsp: dataMaisDias(deps.env.PAGAMENTO_DIAS_VENCIMENTO),
          psp: deps.pspNome,
          origem: 'campanha',
        });
        await tx.insert(cobrancaTitulo).values({
          cobrancaId: id,
          tituloId: alvo.parcelaTituloId,
          origem: 'saldo',
          parcela: alvo.parcela,
          totalParcelas: null,
          valorCentavos: alvo.parcelaValorCentavos,
          vencimento: alvo.parcelaVencimento,
        });
      });
      await deps.boss.send(FILA_COBRANCA_EMITIR, { cobrancaId: id });
      criadas.push(id);
    } catch (err) {
      deps.logger.error(
        { err, waId: alvo.waId, contratoId: alvo.contratoId },
        'campanha de cobrança: falha em um destinatário — os demais seguem',
      );
    }
  }
  return { plano, cobrancasCriadas: criadas };
}
