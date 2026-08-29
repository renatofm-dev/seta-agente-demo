import {
  type EventoEscalonamento,
  type EventoGuardrail,
  type EventoLlm,
  newTraceId,
  type ObsEmitter,
} from '@seta/observability';
import type { Logger } from 'pino';
import type { Db } from './db/index.js';
import { eventoEscalonamento, eventoGuardrail, eventoLlm } from './db/schema.js';

/**
 * Impl drizzle do ObsEmitter (010). Escrita assíncrona fire-and-forget:
 * falha vira warn no log e o turno segue — observabilidade nunca derruba
 * resposta (critério da spec).
 */

export function createDrizzleObsEmitter(db: Db, logger: Logger): ObsEmitter {
  const avisar = (err: unknown, tabela: string) => {
    logger.warn({ err, tabela }, 'observabilidade: falha ao gravar evento (turno segue)');
  };
  const emBackground = (tabela: string, gravar: () => Promise<unknown>): void => {
    try {
      void gravar().catch((err) => avisar(err, tabela));
    } catch (err) {
      avisar(err, tabela); // throw síncrono também não pode derrubar o turno
    }
  };

  return {
    llm(e: EventoLlm) {
      emBackground('evento_llm', () => db.insert(eventoLlm).values({ id: newTraceId(), ...e }));
    },
    guardrail(e: EventoGuardrail) {
      emBackground('evento_guardrail', () =>
        db.insert(eventoGuardrail).values({ id: newTraceId(), ...e }),
      );
    },
    escalonamento(e: EventoEscalonamento) {
      emBackground('evento_escalonamento', () =>
        db.insert(eventoEscalonamento).values({ id: newTraceId(), ...e }),
      );
    },
  };
}
