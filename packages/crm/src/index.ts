import { z } from 'zod';

/**
 * Esqueleto do CRM interno (tickets + HITL). Fluxo completo chega na spec 007.
 */

export const TICKET_STATUS = ['bot', 'aguardando_humano', 'com_humano', 'fechado'] as const;
export const TicketStatusSchema = z.enum(TICKET_STATUS);
export type TicketStatus = z.infer<typeof TicketStatusSchema>;

/** Transições válidas do ciclo de vida do ticket (HITL: bot ⇄ humano). */
const TRANSICOES: Readonly<Record<TicketStatus, readonly TicketStatus[]>> = {
  bot: ['aguardando_humano', 'fechado'],
  aguardando_humano: ['com_humano', 'bot'],
  com_humano: ['bot', 'fechado'],
  fechado: [],
};

export function podeTransicionar(de: TicketStatus, para: TicketStatus): boolean {
  return TRANSICOES[de].includes(para);
}
