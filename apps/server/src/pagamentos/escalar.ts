import { newTraceId } from '@seta/observability';
import type { Db } from '../db/index.js';
import { sinalAprendizado } from '../db/schema.js';
import { aplicarTransicao, garantirTicket } from '../wa/tickets.js';

/** Gatilhos de escalada da 014 (aparecem em evento_escalonamento e no ticket). */
export const TRIGGER_APROVACAO_COBRANCA = 'aprovacao_cobranca';
export const TRIGGER_COBRANCA_BLOQUEADA = 'cobranca_bloqueada';
export const TRIGGER_FALHA_EMISSAO = 'falha_emissao_cobranca';

/**
 * Escalada fora do turno do agente (worker de emissão, bloqueio do fluxo):
 * ticket → aguardando_humano (só se estava com o bot) + sinal de aprendizado,
 * no mesmo padrão do escalarTicket do turno-handler (007/009).
 */
export async function escalarTicketCobranca(
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
