/** `reserva:<reserva.id>` — determinística, e é a PK de `erp_escrita`. */
export const chaveReserva = (reservaId: string): string => `reserva:${reservaId}`;
