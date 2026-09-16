import { randomBytes } from 'node:crypto';

/**
 * OAuth2 `password` do TS Explorer (035): endpoint OWIN `/token`, envelope com
 * `access_token`/`token_type`/`expires_in` e mais os campos fora do padrão que
 * o fornecedor devolve (`userName`, `userId`, `.issued`, `.expires`).
 *
 * Tokens ficam em MEMÓRIA: o simulador é um dublê: reiniciar o processo
 * invalidar tudo é comportamento desejado, não limitação.
 */

/** O fornecedor devolve 86399 — um dia menos um segundo. Copiado, não arredondado. */
export const EXPIRES_IN = 86_399;

export interface Sessao {
  readonly login: string;
  readonly userId: string;
  /** Pessoa que o token representa no painel do cliente; base do escopo `token`. */
  readonly idPessoa: number | null;
}

export interface Envelope {
  readonly access_token: string;
  readonly token_type: 'bearer';
  readonly expires_in: number;
  readonly userName: string;
  readonly userId: string;
  readonly '.issued': string;
  readonly '.expires': string;
}

export interface Autenticador {
  emitir(login: string, senha: string): Envelope | null;
  resolver(header: string | undefined): Sessao | null;
}

interface Credencial extends Sessao {
  readonly senha: string;
}

/** `login:senha[:idPessoa]`, separadas por vírgula. */
export function lerUsuarios(spec: string): Credencial[] {
  return spec
    .split(',')
    .map((linha) => linha.trim())
    .filter(Boolean)
    .map((linha, i) => {
      const [login = '', senha = '', pessoa] = linha.split(':');
      if (!login || !senha) throw new Error(`TSE_SIM_USERS inválido em "${linha}"`);
      return {
        login,
        senha,
        userId: String(i + 1),
        idPessoa: pessoa ? Number(pessoa) : null,
      };
    });
}

export function criarAutenticador(spec: string, agora: () => number = Date.now): Autenticador {
  const credenciais = lerUsuarios(spec);
  const vivos = new Map<string, { sessao: Sessao; expiraEm: number }>();

  return {
    emitir(login, senha) {
      const cred = credenciais.find((c) => c.login === login && c.senha === senha);
      if (!cred) return null;
      const token = randomBytes(48).toString('base64url');
      const emitidoEm = agora();
      const expiraEm = emitidoEm + EXPIRES_IN * 1_000;
      vivos.set(token, { sessao: cred, expiraEm });
      return {
        access_token: token,
        token_type: 'bearer',
        expires_in: EXPIRES_IN,
        userName: cred.login,
        userId: cred.userId,
        '.issued': new Date(emitidoEm).toUTCString(),
        '.expires': new Date(expiraEm).toUTCString(),
      };
    },
    resolver(header) {
      const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
      if (!token) return null;
      const vivo = vivos.get(token);
      if (!vivo) return null;
      if (vivo.expiraEm <= agora()) {
        vivos.delete(token);
        return null;
      }
      return vivo.sessao;
    },
  };
}
