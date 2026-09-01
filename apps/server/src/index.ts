import { createOpenAICompatibleProvider } from '@seta/ai-provider';
import { loadClientConfig } from '@seta/client-config';
import { createPgConnector } from '@seta/erp-connector';
import { createLogger } from '@seta/observability';
import { createExecutor, loadCatalog } from '@seta/query-catalog';
import { createLogGateway, createMetaGateway, type OutboundGateway } from '@seta/wa-meta';
import { buildApp } from './app.js';
import { createAuth } from './auth.js';
import { startBoss } from './boss.js';
import { createDb } from './db/index.js';
import { loadEnv } from './env.js';
import { createDrizzleObsEmitter } from './obs-emitter.js';
import { createDrizzleQueryEventSink } from './query-event-sink.js';
import { createPgVectorStore } from './rag/pgvector-store.js';
import { createSkillRegistry } from './skills/registry.js';
import { registerSinaisDiarios } from './skills/sinais-job.js';
import { registerDebounceWorker } from './wa/debounce.js';
import { registerOutboxSweeper, registerOutboxWorker } from './wa/outbox.js';
import { ticketPermiteBot } from './wa/tickets.js';
import { createAgentTurnoHandler } from './wa/turno-handler.js';

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

const auth = createAuth(db, { secret: env.BETTER_AUTH_SECRET, baseURL: env.BETTER_AUTH_URL });

// VectorStore pgvector (008): retrieval da KB e das skills (ns separados)
const store = createPgVectorStore({ db, dim: env.EMBEDDING_DIM, logger });
await store.ensureIndex();

const registry = createSkillRegistry({
  db,
  store,
  embed:
    provider && env.EMBEDDING_MODEL
      ? (texto) => provider.embed([texto]).then((v) => Array.from(v[0] ?? []))
      : null,
});
await registry.sincronizar(); // reposiciona skills ativas no store (DBs pré-008)
await registerSinaisDiarios(boss, db, logger);

await registerDebounceWorker({
  db,
  boss,
  debounceMs: env.WA_DEBOUNCE_MS,
  turnosConcorrentes: env.AGENT_TURNOS_CONCORRENTES,
  // HITL (007/#47): bot responde em bot_ativo E aguardando_humano (resolvido
  // reabre); só humano_ativo silencia
  ticketGate: (conversaId) => ticketPermiteBot(db, conversaId),
  handler: createAgentTurnoHandler({
    db,
    boss,
    provider,
    catalog,
    executor,
    clientConfig,
    registry,
    store,
    obs: createDrizzleObsEmitter(db, logger),
    logger,
    turnoTimeoutMs: env.AGENT_TURN_TIMEOUT_MS,
    resumoACadaTurnos: env.AGENT_RESUMO_A_CADA_TURNOS,
    debounceMs: env.WA_DEBOUNCE_MS, // #46: reagendamento após turno descartado
  }),
  logger,
});
await registerOutboxWorker({ db, boss, gateway, logger });
await registerOutboxSweeper({ db, boss, gateway, logger });

const app = buildApp({
  env,
  clientConfig,
  wa: { db, boss },
  console: { auth, executor, registry, provider },
});

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
