import { newTraceId } from '@seta/observability';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import type { Logger } from 'pino';
import { FILA_DEBOUNCE } from '../boss.js';
import type { Db } from '../db/index.js';
import { mensagem, turno } from '../db/schema.js';
import { agendarDebounce } from './inbound.js';

/**
 * Debouncer: no disparo, se ainda não houve `debounceMs` de silêncio desde a
 * última mensagem, re-agenda pelo tempo restante; senão agrega as mensagens
 * pendentes num único turno e entrega ao handler (runtime do agente — spec 005).
 */

export interface TurnoPronto {
  readonly id: string;
  readonly conversaId: string;
  readonly textoAgregado: string;
}

export interface TurnoHandler {
  processar(turno: TurnoPronto): Promise<void>;
}

/** Stub da 005: o runtime LangGraph chega lá; aqui só registra o turno pronto. */
export function turnoHandlerLog(logger: Logger): TurnoHandler {
  return {
    async processar(t) {
      logger.info(
        { turnoId: t.id, conversaId: t.conversaId },
        'turno agregado — runtime do agente chega na spec 005',
      );
    },
  };
}

export interface DebounceDeps {
  readonly db: Db;
  readonly boss: PgBoss;
  readonly debounceMs: number;
  readonly handler: TurnoHandler;
  readonly logger: Logger;
  /**
   * Gate do HITL (007): retorna false para NÃO agregar turno (bot silenciado —
   * ticket aguardando/atendido por humano). Ausente ⇒ sempre permite.
   */
  readonly ticketGate?: (conversaId: string) => Promise<boolean>;
}

export async function registerDebounceWorker(deps: DebounceDeps): Promise<void> {
  await deps.boss.work<{ conversaId: string }>(FILA_DEBOUNCE, async (jobs) => {
    for (const job of jobs) {
      await processarDisparo(deps, job.data.conversaId);
    }
  });
}

async function processarDisparo(deps: DebounceDeps, conversaId: string): Promise<void> {
  const pendentes = await deps.db
    .select()
    .from(mensagem)
    .where(
      and(
        eq(mensagem.conversaId, conversaId),
        eq(mensagem.direcao, 'in'),
        isNull(mensagem.turnoId),
      ),
    )
    .orderBy(asc(mensagem.criadoEm));
  if (pendentes.length === 0) return;

  // HITL: bot silenciado ⇒ mensagem NÃO gera turno; fica pendente até devolver
  if (deps.ticketGate && !(await deps.ticketGate(conversaId))) return;

  const ultima = pendentes[pendentes.length - 1] as (typeof pendentes)[number];
  const silencioMs = Date.now() - ultima.criadoEm.getTime();
  if (silencioMs < deps.debounceMs) {
    await agendarDebounce(deps.boss, conversaId, deps.debounceMs - silencioMs);
    return;
  }

  const novoTurno: TurnoPronto = {
    id: newTraceId(),
    conversaId,
    textoAgregado: pendentes.map((m) => m.texto).join('\n'),
  };
  await deps.db.transaction(async (tx) => {
    await tx.insert(turno).values(novoTurno);
    await tx
      .update(mensagem)
      .set({ turnoId: novoTurno.id })
      .where(
        inArray(
          mensagem.id,
          pendentes.map((m) => m.id),
        ),
      );
  });

  try {
    await deps.handler.processar(novoTurno);
  } catch (err) {
    // falha do handler não pode travar o debouncer; o turno fica persistido
    deps.logger.error({ err, turnoId: novoTurno.id }, 'handler de turno falhou');
  }
}
