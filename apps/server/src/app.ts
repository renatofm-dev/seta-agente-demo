import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ClientConfig } from '@seta/client-config';
import { createLogger, newTraceId } from '@seta/observability';
import { type FastifyInstance, fastify, LogController, type RawServerDefault } from 'fastify';
import type { PgBoss } from 'pg-boss';
import type { Logger } from 'pino';
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

export interface BuildAppOptions {
  readonly env: Env;
  readonly clientConfig: ClientConfig;
  /** Sem deps de WA (ex.: teste de healthz) as rotas do canal não são registradas. */
  readonly wa?: WaDeps;
}

export function buildApp({ env, clientConfig, wa }: BuildAppOptions): App {
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
  }

  return app;
}
