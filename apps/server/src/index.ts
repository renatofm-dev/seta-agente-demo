import { loadClientConfig } from '@seta/client-config';
import { createLogger } from '@seta/observability';
import { createLogGateway, createMetaGateway, type OutboundGateway } from '@seta/wa-meta';
import { buildApp } from './app.js';
import { startBoss } from './boss.js';
import { createDb } from './db/index.js';
import { loadEnv } from './env.js';
import { registerDebounceWorker, turnoHandlerLog } from './wa/debounce.js';
import { registerOutboxWorker } from './wa/outbox.js';

const env = loadEnv();
const clientConfig = loadClientConfig(env.CLIENT_CONFIG_PATH);
const logger = createLogger({ name: 'worker', level: env.LOG_LEVEL });

const { db } = createDb(env.DATABASE_URL);
const boss = await startBoss(env.DATABASE_URL, logger);

const gateway: OutboundGateway =
  env.WA_ACCESS_TOKEN && env.WA_PHONE_NUMBER_ID
    ? createMetaGateway({ accessToken: env.WA_ACCESS_TOKEN, phoneNumberId: env.WA_PHONE_NUMBER_ID })
    : createLogGateway(logger);

await registerDebounceWorker({
  db,
  boss,
  debounceMs: env.WA_DEBOUNCE_MS,
  handler: turnoHandlerLog(logger),
  logger,
});
await registerOutboxWorker({ db, boss, gateway, logger });

const app = buildApp({ env, clientConfig, wa: { db, boss } });

try {
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  app.log.info(
    {
      cliente: clientConfig.nome,
      simulador: env.DEV_SIMULATOR,
      gateway: env.WA_ACCESS_TOKEN ? 'meta' : 'log-only',
    },
    'server no ar',
  );
} catch (err) {
  app.log.error(err, 'falha no boot');
  process.exit(1);
}
