import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ClientConfig } from '@seta/client-config';
import { createLogger, newTraceId } from '@seta/observability';
import type { Executor } from '@seta/query-catalog';
import { type FastifyInstance, fastify, LogController, type RawServerDefault } from 'fastify';
import type { PgBoss } from 'pg-boss';
import type { Logger } from 'pino';
import type { Auth } from './auth.js';
import { authRoutes } from './auth-routes.js';
import { consoleRoutes } from './console-routes.js';
import type { Db } from './db/index.js';
import type { Env } from './env.js';
import { devRoutes } from './wa/dev-routes.js';
import { waRoutes } from './wa/routes.js';

export type App = FastifyInstance<
  RawServerDefault,
  IncomingMessage,
  ServerResponse<IncomingMessage>,
  Logger
>;

export interface WaDeps {
  readonly db: Db;
  readonly boss: PgBoss;
}

export interface ConsoleDeps {
  readonly auth: Auth;
  readonly executor: Executor;
}

export interface BuildAppOptions {
  readonly env: Env;
  readonly clientConfig: ClientConfig;
  /** Sem deps de WA (ex.: teste de healthz) as rotas do canal não são registradas. */
  readonly wa?: WaDeps;
  /** Sem deps do console, as rotas /api/* não são registradas. */
  readonly console?: ConsoleDeps;
}

export function buildApp({ env, clientConfig, wa, console: consoleDeps }: BuildAppOptions): App {
  const app = fastify({
    loggerInstance: createLogger({ name: 'server', level: env.LOG_LEVEL }),
    genReqId: () => newTraceId(),
    logController: new LogController({ requestIdLogLabel: 'traceId' }),
  });

  app.get('/healthz', async () => ({
    status: 'ok',
    cliente: clientConfig.nome,
    uptimeSegundos: Math.round(process.uptime()),
  }));

  if (wa) {
    app.register(waRoutes, { env, db: wa.db, boss: wa.boss });
    if (env.DEV_SIMULATOR) {
      app.register(devRoutes, { env, db: wa.db, boss: wa.boss });
    }
    if (consoleDeps) {
      app.register(authRoutes, { auth: consoleDeps.auth });
      app.register(consoleRoutes, {
        db: wa.db,
        boss: wa.boss,
        auth: consoleDeps.auth,
        executor: consoleDeps.executor,
        debounceMs: env.WA_DEBOUNCE_MS,
      });
    }
  }

  return app;
}
