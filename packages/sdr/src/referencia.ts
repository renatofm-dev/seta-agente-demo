/** `lead:{waId}:cota:{cotaId}` — chave de idempotência da proposta (uma aberta por lead×cota). */
export function referenciaProposta(waId: string, cotaId: string): string {
  return `lead:${waId}:cota:${cotaId}`;
}
