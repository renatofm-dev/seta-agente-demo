import { newTraceId } from '@seta/observability';
import { JanelaFechadaError, type OutboundGateway } from '@seta/wa-meta';
import { eq, sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import type { Logger } from 'pino';
import { FILA_OUTBOX } from '../boss.js';
import type { Db } from '../db/index.js';
import { conversa, mensagem, outbox } from '../db/schema.js';

/**
 * Outbox: toda resposta vira linha com dedupe (turnoId+seq) antes de qualquer
 * side effect externo; o worker envia via gateway com retry exponencial do
 * pg-boss e registra a mensagem `out` para os webhooks de status atualizarem.
 */

export interface OutboxDeps {
  readonly db: Db;
  readonly boss: PgBoss;
}

export interface OutboundItem {
  readonly conversaId: string;
  readonly turnoId: string;
  readonly seq: number;
  readonly texto: string;
}

export async function enqueueOutbound(
  deps: OutboxDeps,
  item: OutboundItem,
): Promise<{ duplicada: boolean; outboxId?: string }> {
  const [linha] = await deps.db
    .insert(outbox)
    .values({
      id: newTraceId(),
      conversaId: item.conversaId,
      turnoId: item.turnoId,
      seq: item.seq,
      dedupeKey: `${item.turnoId}:${item.seq}`,
      texto: item.texto,
    })
    .onConflictDoNothing({ target: outbox.dedupeKey })
    .returning();
  if (!linha) return { duplicada: true };
  await deps.boss.send(FILA_OUTBOX, { outboxId: linha.id });
  return { duplicada: false, outboxId: linha.id };
}

export interface OutboxWorkerDeps extends OutboxDeps {
  readonly gateway: OutboundGateway;
  readonly logger: Logger;
}

export async function registerOutboxWorker(deps: OutboxWorkerDeps): Promise<void> {
  await deps.boss.work<{ outboxId: string }>(FILA_OUTBOX, async (jobs) => {
    for (const job of jobs) {
      await enviarLinha(deps, job.data.outboxId);
    }
  });
}

async function enviarLinha(deps: OutboxWorkerDeps, outboxId: string): Promise<void> {
  const [linha] = await deps.db.select().from(outbox).where(eq(outbox.id, outboxId));
  if (linha?.status !== 'pendente') return; // inexistente ou já resolvida (dedupe/reprocesso)
  const [conv] = await deps.db.select().from(conversa).where(eq(conversa.id, linha.conversaId));
  if (!conv) throw new Error(`outbox ${outboxId} sem conversa`);

  try {
    const { waMessageId } = await deps.gateway.send(
      { to: conv.waId, body: linha.texto },
      { expiraEm: conv.janelaExpiraEm },
    );
    await deps.db.transaction(async (tx) => {
      await tx
        .update(outbox)
        .set({
          status: 'enviada',
          waMessageId,
          tentativas: sql`${outbox.tentativas} + 1`,
          atualizadoEm: new Date(),
        })
        .where(eq(outbox.id, outboxId));
      await tx.insert(mensagem).values({
        id: newTraceId(),
        conversaId: conv.id,
        direcao: 'out',
        waMessageId,
        texto: linha.texto,
        status: 'enviada',
        turnoId: linha.turnoId,
      });
    });
  } catch (err) {
    if (err instanceof JanelaFechadaError) {
      // POC: sem template — loga e marca; abertura de ticket chega na 007
      await deps.db
        .update(outbox)
        .set({ status: 'janela_fechada', atualizadoEm: new Date() })
        .where(eq(outbox.id, outboxId));
      deps.logger.warn({ outboxId, waId: conv.waId }, 'janela de 24h fechada — envio abortado');
      return;
    }
    await deps.db
      .update(outbox)
      .set({ tentativas: sql`${outbox.tentativas} + 1`, atualizadoEm: new Date() })
      .where(eq(outbox.id, outboxId));
    throw err; // pg-boss re-tenta com backoff exponencial (config da fila)
  }
}
