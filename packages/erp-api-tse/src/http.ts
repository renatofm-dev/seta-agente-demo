import { ErpAuthError, ErpUnavailableError, erroDeResposta } from './erros.js';
import type { ApiConnector, Scalar } from './tipos.js';
import { criarTokenStore, type TokenStore } from './token.js';

/**
 * Camada HTTP do TSE: token, timeout, retry e a classificação de erro. Tudo que
 * é "como se fala com o fornecedor" mora aqui; `cliente.ts` só sabe de negócio.
 */

export interface TseHttpConfig {
  readonly baseUrl: string;
  readonly username: string;
  readonly password: string;
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs?: number;
  readonly userAgent?: string;
  readonly agora?: () => number;
  /** Injetável no teste para não dormir de verdade entre as tentativas. */
  readonly esperar?: (ms: number) => Promise<void>;
}

/** Só GET re-tenta; escrita nunca (a decisão de repetir é do worker). */
const TENTATIVAS_GET = 3;

export function criarHttp(cfg: TseHttpConfig): { api: ApiConnector; token: TokenStore } {
  const fetchFn = cfg.fetchFn ?? fetch;
  const base = cfg.baseUrl.replace(/\/+$/, '');
  const timeoutPadrao = cfg.timeoutMs ?? 15_000;
  const userAgent = cfg.userAgent ?? 'seta-agente/0.1';
  const esperar = cfg.esperar ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const token = criarTokenStore({
    baseUrl: base,
    username: cfg.username,
    password: cfg.password,
    fetchFn,
    timeoutMs: timeoutPadrao,
    ...(cfg.agora ? { agora: cfg.agora } : {}),
  });

  function url(path: string, query?: Record<string, Scalar>): string {
    const u = new URL(`${base}${path.startsWith('/') ? path : `/${path}`}`);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== null && v !== undefined) u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  async function uma(
    r: {
      method: 'GET' | 'POST' | 'PUT';
      path: string;
      query?: Record<string, Scalar>;
      body?: unknown;
    },
    timeoutMs: number,
  ): Promise<{ status: number; json: unknown; latencyMs: number }> {
    const inicio = Date.now();
    const bearer = await token.obter();
    let res: Response;
    try {
      res = await fetchFn(url(r.path, r.query), {
        method: r.method,
        headers: {
          authorization: `Bearer ${bearer}`,
          'user-agent': userAgent,
          accept: 'application/json',
          ...(r.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(r.body === undefined ? {} : { body: JSON.stringify(r.body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new ErpUnavailableError(
        `TSE sem resposta em ${r.method} ${r.path}: ${err instanceof Error ? err.message : err}`,
      );
    }
    const texto = await res.text();
    if (!res.ok) throw erroDeResposta(`${r.method} ${r.path}`, res.status, texto);
    return {
      status: res.status,
      // três rotas de escrita devolvem string JSON, não objeto — `JSON.parse`
      // resolve as duas formas, e quem interpreta a prosa é o cliente
      json: texto.length > 0 ? JSON.parse(texto) : null,
      latencyMs: Date.now() - inicio,
    };
  }

  const api: ApiConnector = {
    fornecedor: 'tse',

    async request(r, o) {
      const timeoutMs = o?.timeoutMs ?? timeoutPadrao;
      const tentativas = r.method === 'GET' ? TENTATIVAS_GET : 1;
      let ultimo: unknown;
      for (let i = 0; i < tentativas; i++) {
        try {
          return await uma(r, timeoutMs);
        } catch (err) {
          ultimo = err;
          if (err instanceof ErpAuthError) {
            // token pode ter morrido no meio do voo: reautentica UMA vez e
            // repete UMA vez; segundo 401 é credencial errada, não expiração
            token.invalidar();
            return await uma(r, timeoutMs);
          }
          if (!(err instanceof ErpUnavailableError) || i === tentativas - 1) throw err;
          await esperar(2 ** i * 250);
        }
      }
      throw ultimo;
    },

    async health() {
      const inicio = Date.now();
      try {
        await token.obter();
        return { ok: true, latencyMs: Date.now() - inicio };
      } catch {
        return { ok: false, latencyMs: Date.now() - inicio };
      }
    },
  };

  return { api, token };
}
