import { type Candidato, formatarReais, textoPago } from '@seta/cobranca';
import { newTraceId } from '@seta/observability';
import type { OutboundGateway } from '@seta/wa-meta';
import { and, eq, isNull } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import type { Logger } from 'pino';
import { z } from 'zod';
import { FILA_COBRANCA_EVENTO } from '../boss.js';
import type { Db } from '../db/index.js';
import { cobranca, conversa, eventoPsp, mensagem, pagamento } from '../db/schema.js';
import type { Env } from '../env.js';
import { enfileirarBaixas, registrarBaixasPendentes } from '../erp/baixa.js';
import { enqueueOutbound } from '../wa/outbox.js';
import type { CobrancaRow, CobrancaTituloRow, PagamentosRepo } from './repo.js';

/**
 * Processamento dos eventos do PSP (014). O webhook só persiste e enfileira;
 * aqui a cobrança muda de status, a baixa vai para `pagamento` (o espelho do
 * ERP) e o cotista é avisado. Idempotente: evento já processado não repete,
 * e a baixa por (cobrança, título) é única no banco.
 */

export const EVENTOS_PAGO = ['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED'] as const;
export const EVENTOS_ESTORNO = ['PAYMENT_REFUNDED', 'PAYMENT_RECEIVED_IN_CASH_UNDONE'] as const;

/** Corpo do webhook do Asaas (campos que usamos; o resto fica no payload). */
export const EventoPspBodySchema = z.object({
  id: z.string().min(1).max(200),
  event: z.string().min(1).max(100),
  payment: z
    .object({
      id: z.string().min(1),
      status: z.string().optional(),
      value: z.number().optional(),
      externalReference: z.string().nullish(),
      paymentDate: z.string().nullish(),
    })
    .passthrough(),
});
export type EventoPspBody = z.infer<typeof EventoPspBodySchema>;

export interface EventosDeps {
  readonly db: Db;
  readonly boss: PgBoss;
  readonly repo: PagamentosRepo;
  readonly gateway: OutboundGateway;
  readonly env: Pick<Env, 'WA_TEMPLATE_PAGAMENTO_CONFIRMADO'>;
  readonly logger: Logger;
}

/** Persiste o evento (idempotente pelo id) e enfileira; devolve se era novo. */
export async function registrarEventoPsp(
  deps: Pick<EventosDeps, 'db' | 'boss'>,
  psp: string,
  body: EventoPspBody,
): Promise<{ novo: boolean }> {
  const [inserido] = await deps.db
    .insert(eventoPsp)
    .values({
      id: body.id,
      psp,
      tipo: body.event,
      pspCobrancaId: body.payment.id,
      payload: body,
    })
    .onConflictDoNothing({ target: eventoPsp.id })
    .returning({ id: eventoPsp.id });
  if (!inserido) return { novo: false };
  // job DEPOIS do insert: o webhook já pode responder 200
  await deps.boss.send(FILA_COBRANCA_EVENTO, { eventoId: body.id });
  return { novo: true };
}

export async function registerCobrancaEventoWorker(deps: EventosDeps): Promise<void> {
  await deps.boss.work<{ eventoId: string }>(FILA_COBRANCA_EVENTO, async (jobs) => {
    for (const job of jobs) await processarEventoPsp(deps, job.data.eventoId);
  });
}

function candidatosDe(titulos: readonly CobrancaTituloRow[]): Candidato[] {
  return titulos.map((t) => ({
    tituloId: t.tituloId,
    origem: t.origem,
    parcela: t.parcela,
    totalParcelas: t.totalParcelas,
    valorCentavos: t.valorCentavos,
    vencimento: t.vencimento,
    situacao: 'vencida',
  }));
}

export async function processarEventoPsp(deps: EventosDeps, eventoId: string): Promise<void> {
  const [ev] = await deps.db.select().from(eventoPsp).where(eq(eventoPsp.id, eventoId));
  if (!ev || ev.processadoEm) return;
  const body = EventoPspBodySchema.safeParse(ev.payload);
  if (!body.success) {
    // terminal: o payload está gravado e não muda — reprocessar nunca resolveria.
    await concluir(deps, eventoId, 'payload inválido', true);
    return;
  }
  const { event, payment } = body.data;

  const c =
    (await deps.repo.cobrancaPorPsp(payment.id)) ??
    (payment.externalReference
      ? await deps.repo.ultimaCobrancaPorReferencia(payment.externalReference)
      : null);
  if (!c) {
    deps.logger.warn({ eventoId, pspId: payment.id, event }, 'evento de cobrança desconhecida');
    await concluir(deps, eventoId, 'cobrança desconhecida');
    return;
  }

  try {
    if ((EVENTOS_PAGO as readonly string[]).includes(event)) {
      await marcarPaga(deps, c, ev.id, payment.paymentDate ?? null);
    } else if (event === 'PAYMENT_OVERDUE') {
      if (c.status === 'emitida') await mudarStatus(deps.db, c.id, 'expirada');
    } else if (event === 'PAYMENT_DELETED') {
      if (c.status === 'emitida' || c.status === 'emitindo') {
        await mudarStatus(deps.db, c.id, 'cancelada', 'cancelada no PSP');
      }
    } else if ((EVENTOS_ESTORNO as readonly string[]).includes(event)) {
      if (c.status === 'paga') await estornar(deps, c, ev.id);
    } else {
      deps.logger.debug({ eventoId, event }, 'evento do PSP ignorado');
    }
    await concluir(deps, eventoId, null);
  } catch (err) {
    await concluir(deps, eventoId, err instanceof Error ? err.message.slice(0, 500) : String(err));
    throw err; // pg-boss re-tenta; `concluir` deixou processado_em nulo, então o retry passa de novo
  }
}

/**
 * Fecha o evento. Erro comum deixa `processado_em` nulo — é o que o torna
 * "pendente" e elegível ao reprocesso do console (042). `terminal` marca o
 * erro que reprocessar jamais resolveria, preservando a mensagem.
 */
async function concluir(
  deps: EventosDeps,
  eventoId: string,
  erro: string | null,
  terminal = false,
) {
  await deps.db
    .update(eventoPsp)
    .set({ processadoEm: erro && !terminal ? null : new Date(), erro })
    .where(eq(eventoPsp.id, eventoId));
}

/**
 * Reenfileira um evento pendente (042). A guarda de concorrência é o próprio
 * UPDATE condicional: só reenfileira quem continua com `processado_em` nulo,
 * então dois cliques simultâneos geram um job só. Limpar `erro` no mesmo
 * UPDATE dá o sinal de "tentando de novo"; se falhar, `concluir` reescreve.
 */
export async function reenfileirarEventoPsp(
  deps: Pick<EventosDeps, 'db' | 'boss'>,
  eventoId: string,
): Promise<'reenfileirado' | 'ja-processado' | 'inexistente'> {
  const [alvo] = await deps.db
    .update(eventoPsp)
    .set({ erro: null })
    .where(and(eq(eventoPsp.id, eventoId), isNull(eventoPsp.processadoEm)))
    .returning({ id: eventoPsp.id });
  if (!alvo) {
    const [ev] = await deps.db
      .select({ id: eventoPsp.id })
      .from(eventoPsp)
      .where(eq(eventoPsp.id, eventoId));
    return ev ? 'ja-processado' : 'inexistente';
  }
  await deps.boss.send(FILA_COBRANCA_EVENTO, { eventoId });
  return 'reenfileirado';
}

async function mudarStatus(db: Db, id: string, status: CobrancaRow['status'], motivo?: string) {
  await db
    .update(cobranca)
    .set({ status, ...(motivo ? { motivo } : {}), atualizadoEm: new Date() })
    .where(eq(cobranca.id, id));
}

/** paga + 1 `pagamento` por título (a baixa espelhada) — numa transação, idempotente. */
async function marcarPaga(
  deps: EventosDeps,
  c: CobrancaRow,
  eventoId: string,
  paymentDate: string | null,
) {
  if (c.status === 'paga') return;
  if (!['emitindo', 'emitida', 'expirada', 'aguardando_aprovacao'].includes(c.status)) {
    deps.logger.warn(
      { cobrancaId: c.id, status: c.status },
      'pagamento recebido em status inesperado',
    );
    return;
  }
  const titulos = await deps.repo.titulosDe(c.id);
  const recebidoEm = paymentDate ? new Date(`${paymentDate.slice(0, 10)}T12:00:00`) : new Date();
  // 036: a baixa no ERP nasce na MESMA transação do `pagamento` — as duas
  // existem juntas ou não existem. O job só é enfileirado depois do commit, e
  // só para as linhas que realmente entraram (o webhook do Asaas reentrega).
  let baixasNovas: string[] = [];
  await deps.db.transaction(async (tx) => {
    await tx
      .update(cobranca)
      .set({ status: 'paga', pagoEm: recebidoEm, atualizadoEm: new Date() })
      .where(and(eq(cobranca.id, c.id)));
    for (const t of titulos) {
      await tx
        .insert(pagamento)
        .values({
          id: newTraceId(),
          contratoId: c.contratoId,
          tituloId: t.tituloId,
          cobrancaId: c.id,
          valorCentavos: t.valorCentavos,
          metodo: c.metodo,
          recebidoEm,
          status: 'confirmado',
          eventoPspId: eventoId,
        })
        .onConflictDoNothing({ target: [pagamento.cobrancaId, pagamento.tituloId] });
    }
    const gravados = await tx
      .select({ id: pagamento.id, tituloId: pagamento.tituloId, valor: pagamento.valorCentavos })
      .from(pagamento)
      .where(eq(pagamento.cobrancaId, c.id));
    baixasNovas = await registrarBaixasPendentes(
      tx,
      gravados.map((p) => ({
        pagamentoId: p.id,
        contaFinanceiraId: p.tituloId,
        contratoId: c.contratoId,
        valorCentavos: p.valor,
        metodo: c.metodo,
        // o id da cobrança no PSP vira `CodigoAutorizacao` no TSE: dá ao
        // financeiro do cliente o link com o extrato do gateway
        referenciaPsp: c.pspCobrancaId ?? c.referenciaExterna,
      })),
    );
  });
  await enfileirarBaixas(deps.boss, baixasNovas);
  deps.logger.info(
    { cobrancaId: c.id, titulos: titulos.length },
    'pagamento confirmado — baixa registrada',
  );
  await notificarPago(deps, c, titulos);
}

async function estornar(deps: EventosDeps, c: CobrancaRow, eventoId: string) {
  await deps.db.transaction(async (tx) => {
    await tx
      .update(cobranca)
      .set({ status: 'estornada', motivo: `estorno (${eventoId})`, atualizadoEm: new Date() })
      .where(eq(cobranca.id, c.id));
    await tx.update(pagamento).set({ status: 'estornado' }).where(eq(pagamento.cobrancaId, c.id));
  });
  deps.logger.warn({ cobrancaId: c.id }, 'pagamento estornado — baixa revertida');
}

/**
 * Aviso ao cotista: texto pelo outbox com a janela de 24h aberta; fechada,
 * template aprovado (013) se configurado; senão só log — nunca falha o evento.
 */
async function notificarPago(
  deps: EventosDeps,
  c: CobrancaRow,
  titulos: readonly CobrancaTituloRow[],
) {
  const [conv] = await deps.db.select().from(conversa).where(eq(conversa.id, c.conversaId));
  if (!conv) return;
  const texto = textoPago(c.valorCentavos, candidatosDe(titulos));
  const janelaAberta = conv.janelaExpiraEm !== null && conv.janelaExpiraEm.getTime() > Date.now();
  try {
    if (janelaAberta) {
      await enqueueOutbound(
        { db: deps.db, boss: deps.boss },
        { conversaId: c.conversaId, chave: `cobranca:${c.id}:pago`, texto, autor: 'bot' },
      );
      return;
    }
    const modelo = deps.env.WA_TEMPLATE_PAGAMENTO_CONFIRMADO;
    if (!modelo) {
      deps.logger.info({ cobrancaId: c.id }, 'janela fechada e sem template — cotista não avisado');
      return;
    }
    const { waMessageId } = await deps.gateway.sendTemplate({
      to: conv.waId,
      nome: modelo,
      idioma: 'pt_BR',
      variaveis: [formatarReais(c.valorCentavos)],
    });
    await deps.db.insert(mensagem).values({
      id: newTraceId(),
      conversaId: c.conversaId,
      direcao: 'out',
      autor: 'bot',
      waMessageId,
      texto,
      status: 'enviada',
    });
  } catch (err) {
    deps.logger.warn({ err, cobrancaId: c.id }, 'aviso de pagamento confirmado falhou');
  }
}
