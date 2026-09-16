import { ErpAuthError, ErpUnavailableError, erroDeResposta } from './erros.js';
import { TokenSchema } from './tipos.js';

/**
 * OAuth2 `password` do endpoint OWIN `/token`.
 *
 * **POST, não GET.** A coleção do fornecedor salvou o `/token` como GET com
 * corpo; o `fetch` do Node lança `Request with GET/HEAD method cannot have body`,
 * e POST é o verbo padrão do endpoint OWIN do ASP.NET. Divergência registrada em
 * `docs/tse-api-setup.md` §6 e exercitada pelo simulador (035).
 */

export interface TokenConfig {
  readonly baseUrl: string;
  readonly username: string;
  readonly password: string;
  readonly fetchFn: typeof fetch;
  readonly timeoutMs: number;
  /** Injetável no teste. */
  readonly agora?: () => number;
}

export interface TokenStore {
  obter(): Promise<string>;
  invalidar(): void;
}

/** Renova 5 min antes de expirar — relógio nosso e do TSE não são o mesmo. */
const MARGEM_MS = 300_000;

export function criarTokenStore(cfg: TokenConfig): TokenStore {
  const agora = cfg.agora ?? Date.now;
  let token: string | null = null;
  let expiraEm = 0;
  /**
   * Promessa ÚNICA em voo: no boot, N chamadas concorrentes compartilham um
   * refresh. Sem isto o TSE recebe N logins simultâneos do mesmo operador e
   * pode bloquear a conta — e o primeiro sinal disso seria a demo parando.
   */
  let emVoo: Promise<string> | null = null;

  async function autenticar(): Promise<string> {
    const corpo = new URLSearchParams({
      grant_type: 'password',
      username: cfg.username,
      password: cfg.password,
    });
    let res: Response;
    try {
      res = await cfg.fetchFn(`${cfg.baseUrl}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: corpo.toString(),
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
    } catch (err) {
      throw new ErpUnavailableError(
        `TSE sem resposta em POST /token: ${err instanceof Error ? err.message : err}`,
      );
    }
    const texto = await res.text();
    if (!res.ok) {
      const erro = erroDeResposta('POST /token', res.status, texto);
      // 400 do OWIN em credencial errada é auth, não regra de negócio
      throw res.status === 400 ? new ErpAuthError(erro.message, 400) : erro;
    }
    const envelope = TokenSchema.parse(JSON.parse(texto));
    token = envelope.access_token;
    expiraEm = agora() + envelope.expires_in * 1_000 - MARGEM_MS;
    return token;
  }

  return {
    async obter() {
      if (token !== null && agora() < expiraEm) return token;
      if (emVoo) return emVoo;
      emVoo = autenticar().finally(() => {
        emVoo = null;
      });
      return emVoo;
    },
    invalidar() {
      token = null;
      expiraEm = 0;
    },
  };
}
