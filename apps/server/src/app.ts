import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ClientConfig } from '@seta/client-config';
import { createLogger, newTraceId } from '@seta/observability';
import { type FastifyInstance, fastify, LogController, type RawServerDefault } from 'fastify';
import type { Logger } from 'pino';
import type { Env } from './env.js';

export type App = FastifyInstance<
  RawServerDefault,
  IncomingMessage,
  ServerResponse<IncomingMessage>,
  Logger
>;

export interface BuildAppOptions {
  readonly env: Env;
  readonly clientConfig: ClientConfig;
}

export function buildApp({ env, clientConfig }: BuildAppOptions): App {
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

  return app;
}
