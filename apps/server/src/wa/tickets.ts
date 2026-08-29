import {
  type AtorTicket,
  type TicketStatus,
  TransicaoInvalidaError,
  transicionar,
} from '@seta/crm';
import { newTraceId } from '@seta/observability';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { eventoTicket, ticket } from '../db/schema.js';

/**
 * Operações de ticket (007). Toda transição passa pela máquina de estados pura
 * do @seta/crm (lança em transição inválida) e vira linha em evento_ticket.
 */

export type TicketRow = typeof ticket.$inferSelect;

export async function garantirTicket(db: Db, conversaId: string): Promise<TicketRow> {
  const [existente] = await db.select().from(ticket).where(eq(ticket.conversaId, conversaId));
  if (existente) return existente;
  const [novo] = await db
    .insert(ticket)
    .values({ id: newTraceId(), conversaId })
    .onConflictDoNothing({ target: ticket.conversaId })
    .returning();
  if (novo) return novo;
  const [corrida] = await db.select().from(ticket).where(eq(ticket.conversaId, conversaId));
  if (!corrida) throw new Error(`ticket de ${conversaId} sumiu na corrida`);
  return corrida;
}

export async function aplicarTransicao(
  db: Db,
  ticketAtual: TicketRow,
  para: TicketStatus,
  ator: AtorTicket,
  extras: { atorId?: string; motivo?: string } = {},
): Promise<TicketRow> {
  const t = transicionar(ticketAtual.status, para, ator, extras); // lança se inválida
  // #33: UPDATE condicional no status LIDO — dois atendentes assumindo juntos
  // não fazem mais last-write-wins: o segundo cai em 409, sem evento fantasma
  const [atualizado] = await db
    .update(ticket)
    .set({
      status: t.para,
      atendenteId:
        t.para === 'humano_ativo'
          ? (extras.atorId ?? ticketAtual.atendenteId)
          : ticketAtual.atendenteId,
      motivoEscalonamento:
        t.para === 'aguardando_humano' ? (extras.motivo ?? null) : ticketAtual.motivoEscalonamento,
      escaladoEm: t.para === 'aguardando_humano' ? new Date() : ticketAtual.escaladoEm,
      atualizadoEm: new Date(),
    })
    .where(and(eq(ticket.id, ticketAtual.id), eq(ticket.status, ticketAtual.status)))
    .returning();
  if (!atualizado) {
    throw new TransicaoInvalidaError(ticketAtual.status, t.para); // corrida: estado já mudou
  }
  // evento de auditoria só para a transição que VENCEU
  await db.insert(eventoTicket).values({
    id: newTraceId(),
    ticketId: ticketAtual.id,
    deStatus: t.de,
    paraStatus: t.para,
    ator: t.ator,
    atorId: extras.atorId ?? null,
    motivo: extras.motivo ?? null,
  });
  return atualizado;
}

/**
 * Gate do debouncer: turno só nasce com o bot ativo. `resolvido` reabre
 * (nova mensagem do contato); `aguardando_humano`/`humano_ativo` silenciam o
 * bot — as mensagens ficam pendentes até devolverem a conversa.
 */
export async function ticketPermiteBot(db: Db, conversaId: string): Promise<boolean> {
  const t = await garantirTicket(db, conversaId);
  if (t.status === 'bot_ativo') return true;
  if (t.status === 'resolvido') {
    await aplicarTransicao(db, t, 'bot_ativo', 'contato', { motivo: 'nova mensagem reabriu' });
    return true;
  }
  return false;
}
