import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import type { Db } from './db/index.js';
import * as schema from './db/schema.js';

/**
 * Better Auth (007): email+senha com papéis `atendente` e `curador`.
 * O papel não é definível no signup (input: false) — o seed ajusta via banco.
 */

export type Auth = ReturnType<typeof createAuth>;

export interface AuthOptions {
  readonly secret: string;
  readonly baseURL: string;
}

export function createAuth(db: Db, opts: AuthOptions) {
  return betterAuth({
    database: drizzleAdapter(db, { provider: 'pg', schema }),
    secret: opts.secret,
    baseURL: opts.baseURL,
    emailAndPassword: { enabled: true },
    user: {
      additionalFields: {
        role: { type: 'string', defaultValue: 'atendente', input: false },
      },
    },
    trustedOrigins: ['http://localhost:3000'],
  });
}

export type SessaoConsole = {
  readonly userId: string;
  readonly nome: string;
  readonly email: string;
  readonly role: 'atendente' | 'curador';
};

/** Resolve a sessão a partir dos headers da request (cookie Better Auth). */
export async function sessaoDaRequest(
  auth: Auth,
  headers: Record<string, string | string[] | undefined>,
): Promise<SessaoConsole | null> {
  const h = new Headers();
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v === 'string') h.set(k, v);
    else if (Array.isArray(v)) for (const item of v) h.append(k, item);
  }
  const sessao = await auth.api.getSession({ headers: h });
  if (!sessao) return null;
  const role = (sessao.user as { role?: string }).role === 'curador' ? 'curador' : 'atendente';
  return {
    userId: sessao.user.id,
    nome: sessao.user.name,
    email: sessao.user.email,
    role,
  };
}
