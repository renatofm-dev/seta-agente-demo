/**
 * Erros tipados da API do TS Explorer. O worker decide pelo TIPO: auth e negócio
 * não se re-tentam (vão para humano); indisponibilidade re-tenta com backoff.
 * Nunca colapsar em `Error` genérico (crítica registrada na issue #48).
 */

export class ErpError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = 'ErpError';
  }
}

/** 401/403 — token expirado, credencial de outro ambiente, operador sem permissão. */
export class ErpAuthError extends ErpError {
  constructor(message: string, status: number | null) {
    super(message, status);
    this.name = 'ErpAuthError';
  }
}

/**
 * O TSE recusou por regra de negócio — inclusive o caso traiçoeiro:
 * **HTTP 200 com prosa que não é de sucesso**. Não se re-tenta.
 */
export class ErpBusinessError extends ErpError {
  constructor(
    message: string,
    status: number | null,
    readonly corpo: string,
  ) {
    super(message, status);
    this.name = 'ErpBusinessError';
  }
}

/** 5xx, rede, timeout — transitório. */
export class ErpUnavailableError extends ErpError {
  constructor(message: string, status: number | null = null) {
    super(message, status);
    this.name = 'ErpUnavailableError';
  }
}

/**
 * Redação de PII ANTES de cortar o corpo para dentro da mensagem de erro.
 *
 * O adapter do Asaas faz `corpo.slice(0, 300)` e pronto; aqui não dá: o corpo do
 * TSE traz `NomePessoa`, `CpfCnpj`, e-mail e linha digitável, e a mensagem do
 * erro vai parar no log pino. `packages/anonimizacao` cobre o que sai para a
 * LLM — não o que entra no log. Esta função é a barreira desse lado.
 */
export function redigir(corpo: string): string {
  return corpo
    .replace(/("(?:CpfCnpj|CpfCnpjFormatado|Cpf\d?)"\s*:\s*")[^"]*/gi, '$1[CPF]')
    .replace(
      /("(?:NomePessoa|RazaoSocial|NomeCessionario|NomeFantasia|Nome|NomeTitularContaCheque)"\s*:\s*")[^"]*/gi,
      '$1[NOME]',
    )
    .replace(/("(?:Email|EnderecoEmail)"\s*:\s*")[^"]*/gi, '$1[EMAIL]')
    .replace(
      /("(?:LinhaDigitavelBoleto|CodigoBarrasBoleto|PixCopiaECola)"\s*:\s*")[^"]*/gi,
      '$1[BOLETO]',
    )
    .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, '[CPF]')
    .replace(/\b\d{11,}\b/g, '[NUM]');
}

export function erroDeResposta(rota: string, status: number, corpo: string): ErpError {
  const resumo = `${rota} ${status}: ${redigir(corpo).slice(0, 300)}`;
  if (status === 401 || status === 403) return new ErpAuthError(`TSE auth ${resumo}`, status);
  if (status >= 500) return new ErpUnavailableError(`TSE indisponível ${resumo}`, status);
  return new ErpBusinessError(`TSE recusou ${resumo}`, status, redigir(corpo));
}
