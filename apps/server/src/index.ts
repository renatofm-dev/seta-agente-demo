import { createOpenAICompatibleProvider } from '@seta/ai-provider';
import { loadClientConfig } from '@seta/client-config';
import { createPgConnector } from '@seta/erp-connector';
import { createLogger } from '@seta/observability';
import { createExecutor, loadCatalog } from '@seta/query-catalog';
import { createLogGateway, createMetaGateway, type OutboundGateway } from '@seta/wa-meta';
import { buildApp } from './app.js';
import { startBoss } from './boss.js';
import { createDb } from './db/index.js';
import { loadEnv } from './env.js';
import { createDrizzleQueryEventSink } from './query-event-sink.js';
import { registerDebounceWorker } from './wa/debounce.js';
import { registerOutboxWorker } from './wa/outbox.js';
import { createAgentTurnoHandler } from './wa/turno-handler.js';
import { loadVinculos } from './wa/vinculo.js';

const env = loadEnv();
const clientConfig = loadClientConfig(env.CLIENT_CONFIG_PATH);
const logger = createLogger({ name: 'worker', level: env.LOG_LEVEL });

const { db } = createDb(env.DATABASE_URL);
const boss = await startBoss(env.DATABASE_URL, logger);

// catálogo de queries: única via de dado do ERP (003)
const catalog = loadCatalog(env.CATALOG_DIR);
const connector = createPgConnector({ url: env.ERP_DATABASE_URL });
const executor = createExecutor({
  catalog,
  connector,
  sink: createDrizzleQueryEventSink(db),
  logger,
});

// provedor LLM (005): ausente ⇒ agente responde fallback honesto
const provider =
  env.LLM_BASE_URL && env.LLM_API_KEY && env.LLM_MODEL
    ? createOpenAICompatibleProvider({
        baseUrl: env.LLM_BASE_URL,
        apiKey: env.LLM_API_KEY,
        model: env.LLM_MODEL,
        embeddingModel: env.EMBEDDING_MODEL,
      })
    : null;

const gateway: OutboundGateway =
  env.WA_ACCESS_TOKEN && env.WA_PHONE_NUMBER_ID
    ? createMetaGateway({ accessToken: env.WA_ACCESS_TOKEN, phoneNumberId: env.WA_PHONE_NUMBER_ID })
    : createLogGateway(logger);

await registerDebounceWorker({
  db,
  boss,
  debounceMs: env.WA_DEBOUNCE_MS,
  handler: createAgentTurnoHandler({
    db,
    boss,
    provider,
    catalog,
    executor,
    clientConfig,
    vinculos: loadVinculos(env.CONTATOS_PATH),
    logger,
    turnoTimeoutMs: env.AGENT_TURN_TIMEOUT_MS,
    resumoACadaTurnos: env.AGENT_RESUMO_A_CADA_TURNOS,
  }),
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
      llm: provider ? provider.modelId : 'não configurado (fallback)',
      toolsCatalogo: catalog.list().filter((e) => e.tool.expose).length,
    },
    'server no ar',
  );
} catch (err) {
  app.log.error(err, 'falha no boot');
  process.exit(1);
}
