import { newTraceId } from '@seta/observability';
import type { InboundText } from '@seta/wa-meta';
import { sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { FILA_DEBOUNCE } from '../boss.js';
import type { Db } from '../db/index.js';
import { conversa, mensagem } from '../db/schema.js';

/**
 * Caminho ÚNICO de entrada (webhook real e simulador): upsert idempotente da
 * mensagem por wa_message_id, janela de 24h na conversa e agendamento do debounce.
 */

const JANELA_MS = 24 * 3600 * 1000;

export interface InboundDeps {
  readonly db: Db;
  readonly boss: PgBoss;
  readonly debounceMs: number;
}

export interface InboundResultado {
  readonly conversaId: string;
  readonly duplicada: boolean;
}

export async function processInbound(
  deps: InboundDeps,
  msg: InboundText,
): Promise<InboundResultado> {
  const janelaExpiraEm = new Date(msg.timestamp.getTime() + JANELA_MS);

  // #46: upsert da conversa + insert da mensagem numa transação SÓ. O lock de
  // linha da conversa (do upsert) serializa este insert com a checagem de
  // pendentes do turno-handler — mensagem nunca "cai no vão" entre a checagem
  // e o enfileiramento da resposta.
  const { conv, inseridas } = await deps.db.transaction(async (tx) => {
    const [convTx] = await tx
      .insert(conversa)
      .values({ id: newTraceId(), waId: msg.waId, janelaExpiraEm })
      .onConflictDoUpdate({
        target: conversa.waId,
        // GREATEST: reentrega/entrega fora de ordem de mensagem antiga não pode
        // REGREDIR a janela aberta (timestamp vem da Meta, não do relógio local)
        set: {
          janelaExpiraEm: sql`GREATEST(${conversa.janelaExpiraEm}, excluded.janela_expira_em)`,
        },
      })
      .returning();
    if (!convTx) throw new Error('upsert de conversa não retornou linha');

    const inseridasTx = await tx
      .insert(mensagem)
      .values({
        id: newTraceId(),
        conversaId: convTx.id,
        direcao: 'in',
        waMessageId: msg.waMessageId,
        texto: msg.texto,
        status: 'recebida',
      })
      .onConflictDoNothing({ target: mensagem.waMessageId })
      .returning();
    return { conv: convTx, inseridas: inseridasTx };
  });

  // reentrega do mesmo wa_message_id: nada muda, nada é re-agendado
  if (inseridas.length === 0) return { conversaId: conv.id, duplicada: true };

  await agendarDebounce(deps.boss, conv.id, deps.debounceMs);
  return { conversaId: conv.id, duplicada: false };
}

/**
 * singletonKey = conversaId evita fila cheia de jobs por rajada; se o singleton
 * recusar (ex.: job ativo neste instante), agenda sem key — o worker re-checa o
 * silêncio e sai cedo, então um job extra é inofensivo.
 */
export async function agendarDebounce(boss: PgBoss, conversaId: string, debounceMs: number) {
  const startAfter = new Date(Date.now() + debounceMs);
  const id = await boss.send(
    FILA_DEBOUNCE,
    { conversaId },
    { singletonKey: conversaId, startAfter },
  );
  if (id === null) {
    await boss.send(FILA_DEBOUNCE, { conversaId }, { startAfter });
  }
}
