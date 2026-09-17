/** `venda:<venda.id>` — determinística, e é a PK de `erp_escrita`. */
export const chaveVenda = (vendaId: string): string => `venda:${vendaId}`;
