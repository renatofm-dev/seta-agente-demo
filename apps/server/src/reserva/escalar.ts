import { newTraceId } from '@seta/observability';
import type { Db } from '../db/index.js';
import { sinalAprendizado } from '../db/schema.js';
import { aplicarTransicao, garantirTicket } from '../wa/tickets.js';

/**
 * Escalada da 038, fora do turno do agente. Cópia em forma do
 * `pagamentos/escalar.ts`, mas com triggers PRÓPRIOS de propósito: o trigger vai
 * para `evento_escalonamento` e para o payload do sinal de aprendizado, e
 * misturar reserva com cobrança cegaria a métrica de HITL por motivo.
 */

export const TRIGGER_APROVACAO_RESERVA = 'aprovacao_reserva';
export const TRIGGER_RESERVA_BLOQUEADA = 'reserva_bloqueada';
export const TRIGGER_FALHA_RESERVA = 'falha_reserva_erp';

export async function escalarTicketReserva(
  db: Db,
  conversaId: string,
  trigger: string,
  motivo: string,
  extras: { refId?: string; textoUsuario?: string } = {},
): Promise<boolean> {
  const atual = await garantirTicket(db, conversaId);
  if (atual.status !== 'bot_ativo') return false;
  await aplicarTransicao(db, atual, 'aguardando_humano', 'bot', { motivo });
  await db.insert(sinalAprendizado).values({
    id: newTraceId(),
    tipo: 'escalonamento',
    ticketId: atual.id,
    conversaId,
    payload: {
      refId: extras.refId ?? null,
      motivo,
      trigger,
      textoUsuario: extras.textoUsuario ?? null,
    },
  });
  return true;
}
