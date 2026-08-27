import { newTraceId } from '@seta/observability';
import type { InboundText } from '@seta/wa-meta';
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

  const [conv] = await deps.db
    .insert(conversa)
    .values({ id: newTraceId(), waId: msg.waId, janelaExpiraEm })
    .onConflictDoUpdate({ target: conversa.waId, set: { janelaExpiraEm } })
    .returning();
  if (!conv) throw new Error('upsert de conversa não retornou linha');

  const inseridas = await deps.db
    .insert(mensagem)
    .values({
      id: newTraceId(),
      conversaId: conv.id,
      direcao: 'in',
      waMessageId: msg.waMessageId,
      texto: msg.texto,
      status: 'recebida',
    })
    .onConflictDoNothing({ target: mensagem.waMessageId })
    .returning();

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
