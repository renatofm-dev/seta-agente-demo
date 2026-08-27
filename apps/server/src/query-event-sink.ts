import { newTraceId } from '@seta/observability';
import type { QueryEventSink } from '@seta/query-catalog';
import type { Db } from './db/index.js';
import { eventoQuery } from './db/schema.js';

/** Sink real de evento_query: grava a auditoria do executor no banco `app`. */
export function createDrizzleQueryEventSink(db: Db): QueryEventSink {
  return {
    async record(evento) {
      await db.insert(eventoQuery).values({
        id: newTraceId(), // UUIDv7
        traceId: evento.traceId,
        entryId: evento.entryId,
        ok: evento.ok,
        latencyMs: evento.latencyMs,
        linhas: evento.linhas,
        truncated: evento.truncated,
        erro: evento.erro ?? null,
      });
    },
  };
}
