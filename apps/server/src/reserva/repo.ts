import { and, desc, eq, ne, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { fluxoReserva, reserva } from '../db/schema.js';

/**
 * Acesso às tabelas da 038. Interface explícita para o worker e as tools
 * receberem um stub nos testes de unidade — mesmo desenho de `PagamentosRepo`.
 */

export type FluxoReservaRow = typeof fluxoReserva.$inferSelect;
export type ReservaRow = typeof reserva.$inferSelect;

export interface ReservaRepo {
  /** O fluxo que ainda está de pé nesta conversa (garantido único pelo índice). */
  fluxoAtivo(conversaId: string): Promise<FluxoReservaRow | null>;
  reservaPorId(id: string): Promise<ReservaRow | null>;
  reservasDoContrato(contratoId: string, limite: number): Promise<ReservaRow[]>;
  reservasDaConversa(conversaId: string, limite: number): Promise<ReservaRow[]>;
  /** Uma reserva viva para a mesma semana — a guarda contra duplicata. */
  reservaVivaNoPeriodo(
    contratoId: string,
    checkIn: string,
    checkOut: string,
  ): Promise<ReservaRow | null>;
}

export function createReservaRepo(db: Db): ReservaRepo {
  return {
    async fluxoAtivo(conversaId) {
      const [f] = await db
        .select()
        .from(fluxoReserva)
        .where(and(eq(fluxoReserva.conversaId, conversaId), ne(fluxoReserva.etapa, 'encerrado')))
        .limit(1);
      return f ?? null;
    },

    async reservaPorId(id) {
      const [r] = await db.select().from(reserva).where(eq(reserva.id, id));
      return r ?? null;
    },

    async reservasDoContrato(contratoId, limite) {
      return db
        .select()
        .from(reserva)
        .where(eq(reserva.contratoId, contratoId))
        .orderBy(desc(reserva.criadoEm))
        .limit(limite);
    },

    async reservasDaConversa(conversaId, limite) {
      return db
        .select()
        .from(reserva)
        .where(eq(reserva.conversaId, conversaId))
        .orderBy(desc(reserva.criadoEm))
        .limit(limite);
    },

    async reservaVivaNoPeriodo(contratoId, checkIn, checkOut) {
      const [r] = await db
        .select()
        .from(reserva)
        .where(
          and(
            eq(reserva.contratoId, contratoId),
            eq(reserva.checkIn, checkIn),
            eq(reserva.checkOut, checkOut),
            sql`${reserva.status} IN ('aguardando_aprovacao','criando','criada','confirmada')`,
          ),
        )
        .limit(1);
      return r ?? null;
    },
  };
}
