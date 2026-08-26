/**
 * Masking LGPD por coluna (mecanismo genérico; a POC traz o masker `cnpj`).
 * Aplicado no executor, ANTES de qualquer retorno ao agente.
 */

type Masker = (valor: unknown) => unknown;

function mascararCnpj(valor: unknown): unknown {
  if (typeof valor !== 'string') return valor;
  const digitos = valor.replace(/\D/g, '');
  if (digitos.length !== 14) return '***';
  return `**.***.***/****-${digitos.slice(12)}`;
}

export const MASKERS: Readonly<Record<string, Masker>> = {
  cnpj: mascararCnpj,
};

export function applyMasking(
  rows: readonly Record<string, unknown>[],
  masking: Readonly<Record<string, string>>,
): Record<string, unknown>[] {
  const pares = Object.entries(masking);
  if (pares.length === 0) return [...rows];
  return rows.map((row) => {
    const mascarada = { ...row };
    for (const [coluna, nomeMasker] of pares) {
      if (coluna in mascarada) {
        const masker = MASKERS[nomeMasker];
        if (masker) mascarada[coluna] = masker(mascarada[coluna]);
      }
    }
    return mascarada;
  });
}
