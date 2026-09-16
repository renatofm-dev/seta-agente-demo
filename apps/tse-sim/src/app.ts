import { type FastifyInstance, type FastifyReply, fastify } from 'fastify';
import { z } from 'zod';
import { type Autenticador, criarAutenticador } from './auth.js';
import type { Banco } from './db.js';
import type { Env } from './env.js';
import { cadastrosRoutes } from './rotas/cadastros.js';
import { financeiroRoutes } from './rotas/financeiro.js';
import { lookupRoutes } from './rotas/lookup.js';
import { painelDoClienteRoutes } from './rotas/painel-do-cliente.js';
import { utilizacaoContratoRoutes } from './rotas/utilizacao-contrato.js';

/**
 * Simulador da API do TS Explorer (035). Responde COMO o fornecedor — mesmo
 * PascalCase, mesmas datas com -03:00, mesmo envelope OAuth2 — sobre o mesmo
 * `erp_mock` que o produto lê por SQL. A fidelidade é provada contra os 89
 * exemplos salvos da coleção (`test/contrato.test.ts`).
 *
 * Regra que não se negocia: o simulador NUNCA calcula regra de negócio nossa.
 * Ele é fiel ao TSE, ponto — senão o adapter passa contra o dublê e falha
 * contra o TSE real, que é exatamente o erro que este serviço existe para evitar.
 */

/** A instância do simulador — o tipo que os testes injetam com `app.inject()`. */
export type App = FastifyInstance;

export interface BuildOptions {
  readonly env: Env;
  readonly db: Banco;
  /** Injetável no teste; por padrão sai de `TSE_SIM_USERS`. */
  readonly auth?: Autenticador;
}

const CredenciaisSchema = z.object({
  grant_type: z.literal('password'),
  username: z.string().min(1),
  password: z.string().min(1),
});

/** O OWIN responde 400 com este envelope quando a senha não confere. */
const CREDENCIAL_INVALIDA = {
  error: 'invalid_grant',
  error_description: 'The user name or password is incorrect.',
} as const;

export function buildTseSimApp({ env, db, auth }: BuildOptions): App {
  const app = fastify({ logger: { level: env.LOG_LEVEL } });
  const autenticador = auth ?? criarAutenticador(env.TSE_SIM_USERS);

  // o /token do OWIN é form-urlencoded; sem parser próprio precisaríamos de uma
  // dependência a mais, e a stack desta spec é fechada (Fastify, Zod, pg)
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, corpo, done) => {
      done(null, Object.fromEntries(new URLSearchParams(corpo as string)));
    },
  );

  // caos controlado (041 vai precisar): latência fixa e falha por basis points
  if (env.TSE_SIM_LATENCIA_MS > 0 || env.TSE_SIM_FALHA_BPS > 0) {
    app.addHook('onRequest', async (req, reply) => {
      if (req.url === '/healthz') return;
      if (env.TSE_SIM_LATENCIA_MS > 0) {
        await new Promise((r) => setTimeout(r, env.TSE_SIM_LATENCIA_MS));
      }
      if (env.TSE_SIM_FALHA_BPS > 0 && Math.random() * 10_000 < env.TSE_SIM_FALHA_BPS) {
        await reply.code(500).send({ Message: 'An error has occurred.' });
      }
    });
  }

  app.setErrorHandler(async (erro, _req, reply) => {
    if (erro instanceof z.ZodError) {
      // o ASP.NET devolve 400 com ModelState; o que importa ao adapter é o status
      return reply.code(400).send({ Message: 'The request is invalid.', ModelState: erro.issues });
    }
    app.log.error({ err: erro }, 'falha no simulador');
    return reply.code(500).send({ Message: 'An error has occurred.' });
  });

  app.get('/healthz', async () => ({ status: 'ok', escopo: env.TSE_SIM_PAINEL_ESCOPO }));

  const emitir = (dados: unknown, reply: FastifyReply) => {
    const cred = CredenciaisSchema.safeParse(dados);
    if (!cred.success) return reply.code(400).send(CREDENCIAL_INVALIDA);
    const envelope = autenticador.emitir(cred.data.username, cred.data.password);
    if (!envelope) return reply.code(400).send(CREDENCIAL_INVALIDA);
    return envelope;
  };

  app.post('/token', async (req, reply) => emitir(req.body, reply));
  /**
   * DIVERGÊNCIA DA COLEÇÃO, registrada de propósito: o fornecedor salvou o
   * `/token` como **GET com body**. O `fetch` do Node recusa isso
   * ("Request with GET/HEAD method cannot have body"), então esta rota lê as
   * credenciais da query string — é o único jeito de um GET carregá-las. O
   * adapter da 036 usa POST, que é o verbo padrão do endpoint OWIN.
   */
  app.get('/token', async (req, reply) => emitir(req.query, reply));

  app.register(painelDoClienteRoutes, {
    db,
    auth: autenticador,
    escopo: env.TSE_SIM_PAINEL_ESCOPO,
  });
  app.register(utilizacaoContratoRoutes, { db, auth: autenticador });
  app.register(cadastrosRoutes, { db, auth: autenticador });
  app.register(financeiroRoutes, { db, auth: autenticador });
  app.register(lookupRoutes, { auth: autenticador });

  return app;
}
