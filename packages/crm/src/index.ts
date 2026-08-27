import { z } from 'zod';

/**
 * CRM mínimo da POC: máquina de estados do ticket como FUNÇÃO PURA testável.
 * Transições inválidas lançam TransicaoInvalidaError.
 */

export const TICKET_STATUS = [
  'bot_ativo',
  'aguardando_humano',
  'humano_ativo',
  'resolvido',
] as const;
export const TicketStatusSchema = z.enum(TICKET_STATUS);
export type TicketStatus = z.infer<typeof TicketStatusSchema>;

export const ATORES = ['sistema', 'bot', 'atendente', 'contato'] as const;
export type AtorTicket = (typeof ATORES)[number];

/** Transições válidas do ciclo HITL. */
const TRANSICOES: Readonly<Record<TicketStatus, readonly TicketStatus[]>> = {
  bot_ativo: ['aguardando_humano', 'resolvido'],
  aguardando_humano: ['humano_ativo', 'bot_ativo'],
  humano_ativo: ['bot_ativo', 'resolvido'],
  resolvido: ['bot_ativo'], // reabertura: nova mensagem do contato
};

export class TransicaoInvalidaError extends Error {
  constructor(
    public readonly de: TicketStatus,
    public readonly para: TicketStatus,
  ) {
    super(`transição de ticket inválida: ${de} → ${para}`);
    this.name = 'TransicaoInvalidaError';
  }
}

export function podeTransicionar(de: TicketStatus, para: TicketStatus): boolean {
  return TRANSICOES[de].includes(para);
}

export interface TransicaoTicket {
  readonly de: TicketStatus;
  readonly para: TicketStatus;
  readonly ator: AtorTicket;
  readonly atorId?: string;
  readonly motivo?: string;
}

/** Valida e descreve a transição; lança TransicaoInvalidaError se proibida. */
export function transicionar(
  de: TicketStatus,
  para: TicketStatus,
  ator: AtorTicket,
  extras: { atorId?: string; motivo?: string } = {},
): TransicaoTicket {
  if (!podeTransicionar(de, para)) throw new TransicaoInvalidaError(de, para);
  return { de, para, ator, ...extras };
}
