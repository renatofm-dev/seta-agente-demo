/**
 * Referências externas determinísticas — a chave de idempotência no PSP.
 * Mesmo contrato + mesmos títulos ⇒ mesma referência ⇒ mesma cobrança.
 */

export function referenciaCliente(contratoId: string): string {
  return `contrato:${contratoId}`;
}

export function referenciaCobranca(contratoId: string, tituloIds: readonly string[]): string {
  const ids = [...new Set(tituloIds)].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  if (ids.length === 0) throw new Error('referência de cobrança sem títulos');
  return `contrato:${contratoId}:titulos:${ids.join('+')}`;
}
