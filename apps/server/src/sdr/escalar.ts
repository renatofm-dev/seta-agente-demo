/**
 * Gatilhos de escalada da 015 (aparecem em evento_escalonamento e no ticket).
 * A mecânica (ticket → aguardando_humano + sinal) é a mesma da 014 —
 * `escalarTicketCobranca` em pagamentos/escalar.ts é genérica e é reutilizada.
 */
export { escalarTicketCobranca as escalarTicketSdr } from '../pagamentos/escalar.js';

/** Lead pediu valor abaixo do piso da alçada — humano valida a proposta. */
export const TRIGGER_DESCONTO_ACIMA_ALCADA = 'desconto_acima_alcada';
/** Sem cota para o perfil, ou limite diário de propostas — o comercial assume. */
export const TRIGGER_SDR_COMERCIAL = 'interesse_compra';
