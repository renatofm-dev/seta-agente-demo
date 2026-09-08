/**
 * Erros tipados do PSP. O worker de emissão decide pelo TIPO: auth e negócio não
 * se re-tentam (vão para humano); indisponibilidade re-tenta com backoff.
 * Nunca colapsar em `Error` genérico (crítica registrada na issue #48).
 */

export class PspError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = 'PspError';
  }
}

/** 401/403 — chave inválida, expirada ou de outro ambiente. */
export class PspAuthError extends PspError {
  constructor(message: string, status: number) {
    super(message, status);
    this.name = 'PspAuthError';
  }
}

/** 4xx de negócio (validação, cliente inexistente, cobrança já paga...). */
export class PspBusinessError extends PspError {
  constructor(
    message: string,
    status: number,
    readonly detalhes: readonly string[],
  ) {
    super(message, status);
    this.name = 'PspBusinessError';
  }
}

/** 5xx, rede, timeout — transitório. */
export class PspUnavailableError extends PspError {
  constructor(message: string, status: number | null = null) {
    super(message, status);
    this.name = 'PspUnavailableError';
  }
}

/** Extrai `errors[].description` do corpo padrão do Asaas (quando houver). */
export function descricoesDoCorpo(corpo: string): string[] {
  try {
    const json = JSON.parse(corpo) as { errors?: { description?: string; code?: string }[] };
    return (json.errors ?? [])
      .map((e) => e.description ?? e.code ?? '')
      .filter((s) => s.length > 0);
  } catch {
    return [];
  }
}

export function erroDeResposta(rota: string, status: number, corpo: string): PspError {
  const resumo = `${rota} ${status}: ${corpo.slice(0, 300)}`;
  if (status === 401 || status === 403) return new PspAuthError(`PSP auth ${resumo}`, status);
  if (status >= 500) return new PspUnavailableError(`PSP indisponível ${resumo}`, status);
  return new PspBusinessError(`PSP recusou ${resumo}`, status, descricoesDoCorpo(corpo));
}
