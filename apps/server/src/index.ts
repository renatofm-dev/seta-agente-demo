import { createOpenAICompatibleProvider } from '@seta/ai-provider';
import { loadClientConfig } from '@seta/client-config';
import { createErpSimulado, createTseErpApi, type ErpWriter } from '@seta/erp-api-tse';
import { createPgConnector } from '@seta/erp-connector';
import { createLogger } from '@seta/observability';
import {
  createAsaasProvider,
  createSimulatedPaymentProvider,
  type PaymentProvider,
} from '@seta/payment-provider';
import { createExecutor, loadCatalog } from '@seta/query-catalog';
import {
  createLogGateway,
  createMetaGateway,
  createMetaTemplateApi,
  type OutboundGateway,
} from '@seta/wa-meta';
import { montarProviderAnonimizado } from './anonimizacao.js';
import { buildApp } from './app.js';
import { createAuth } from './auth.js';
import { startBoss } from './boss.js';
import { createDb } from './db/index.js';
import { loadEnv } from './env.js';
import { registerErpBaixaWorker } from './erp/baixa.js';
import { createDrizzleObsEmitter } from './obs-emitter.js';
import { createExecutorConciliado } from './pagamentos/conciliacao.js';
import { registerCobrancaEmitirWorker } from './pagamentos/emitir.js';
import { registerCobrancaEventoWorker } from './pagamentos/eventos.js';
import { createPagamentosRepo } from './pagamentos/repo.js';
import { createDrizzleQueryEventSink } from './query-event-sink.js';
import { createPgVectorStore } from './rag/pgvector-store.js';
import { createReservaRepo } from './reserva/repo.js';
import { registerErpReservaWorker } from './reserva/worker.js';
import { createSdrRepo } from './sdr/repo.js';
import { createSkillRegistry } from './skills/registry.js';
import { registerSinaisDiarios } from './skills/sinais-job.js';
import { createVendaRepo } from './venda/repo.js';
import { registerErpVendaWorker } from './venda/worker.js';
import { registerDebounceWorker } from './wa/debounce.js';
import { registerDisparoWorker } from './wa/disparo.js';
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
// 014: a conciliação faz as leituras financeiro.* refletirem as baixas
// registradas aqui (o ERP é read-only); em produção o ERP faz a baixa e a
// camada some — por isso fica atrás do port, transparente para todos
const pagamentosRepo = createPagamentosRepo(db, env.ERP_CONCILIACAO);
const executorCru = createExecutor({
  catalog,
  connector,
  sink: createDrizzleQueryEventSink(db),
  logger,
});
// 036: com `off` o executor nem é decorado — a leitura é crua do ERP. Com
// `auto` (default) a conciliação compensa só o que ainda não chegou ao TSE.
const executor =
  env.ERP_CONCILIACAO === 'off'
    ? executorCru
    : createExecutorConciliado(executorCru, pagamentosRepo);

// 014: PSP (ADR 0001) — sem chave, simulado; a base URL decide sandbox/produção
const psp: PaymentProvider = env.ASAAS_API_KEY
  ? createAsaasProvider({ baseUrl: env.ASAAS_BASE_URL, apiKey: env.ASAAS_API_KEY })
  : createSimulatedPaymentProvider();

// 036: escrita no ERP pela API do TSE — sem TSE_BASE_URL, o writer simulado
// assume e a baixa vira registro local (mesmo desenho do PSP acima)
const erpWriter: ErpWriter =
  env.TSE_BASE_URL && env.TSE_USERNAME && env.TSE_PASSWORD
    ? createTseErpApi({
        baseUrl: env.TSE_BASE_URL,
        username: env.TSE_USERNAME,
        password: env.TSE_PASSWORD,
        timeoutMs: env.TSE_TIMEOUT_MS,
      })
    : createErpSimulado();
logger.info(
  { erp: env.TSE_BASE_URL ? 'api-tse' : 'simulado', conciliacao: env.ERP_CONCILIACAO },
  'escrita no ERP',
);

/**
 * 038: a reserva escreve com credencial PRÓPRIA quando houver. O TSE grava quem
 * pediu (`IdOperadorRespSolicitacao`), e é isso que separa, na auditoria, a
 * reserva feita pelo robô da feita por um atendente. Sem a credencial dedicada,
 * cai na da 036 — e o rastro fica misturado, o que é decisão consciente e não
 * acidente.
 */
const reservaWriter: ErpWriter =
  env.TSE_BASE_URL && env.TSE_RESERVA_USERNAME && env.TSE_RESERVA_PASSWORD
    ? createTseErpApi({
        baseUrl: env.TSE_BASE_URL,
        username: env.TSE_RESERVA_USERNAME,
        password: env.TSE_RESERVA_PASSWORD,
        timeoutMs: env.TSE_TIMEOUT_MS,
      })
    : erpWriter;
const reservaRepo = createReservaRepo(db);
const vendaRepo = createVendaRepo(db);
logger.info(
  {
    reserva: clientConfig.modulos.reserva,
    operador: env.TSE_RESERVA_USERNAME ? 'dedicado' : 'compartilhado com a integração',
  },
  'reserva no ERP',
);

// provedor LLM (005): ausente ⇒ agente responde fallback honesto
const providerBase =
  env.LLM_BASE_URL && env.LLM_API_KEY && env.LLM_MODEL
    ? createOpenAICompatibleProvider({
        baseUrl: env.LLM_BASE_URL,
        apiKey: env.LLM_API_KEY,
        model: env.LLM_MODEL,
        embeddingModel: env.EMBEDDING_MODEL,
      })
    : null;
// 016: tudo que sai para a LLM passa pelo decorator de anonimização — um
// ponto de corte cobre os cinco chamadores sem que nenhum deles mude
const anonimizacao =
  providerBase && env.LLM_ANONIMIZAR
    ? await montarProviderAnonimizado({ env, db, logger, provider: providerBase })
    : null;
const provider = anonimizacao?.provider ?? providerBase;

const gateway: OutboundGateway =
  env.WA_ACCESS_TOKEN && env.WA_PHONE_NUMBER_ID
    ? createMetaGateway({ accessToken: env.WA_ACCESS_TOKEN, phoneNumberId: env.WA_PHONE_NUMBER_ID })
    : createLogGateway(logger);

// 013: gestão de modelos exige o WABA — sem ele a plataforma explica o 503
const templateApi =
  env.WA_ACCESS_TOKEN && env.WA_WABA_ID
    ? createMetaTemplateApi({ accessToken: env.WA_ACCESS_TOKEN, wabaId: env.WA_WABA_ID })
    : null;

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
    pagamentos: { repo: pagamentosRepo, psp, env }, // 014
    sdr: { repo: createSdrRepo(db), env }, // 015: só age na raia sem vínculo com modulos.sdr
    reserva: { repo: reservaRepo, writer: reservaWriter, env }, // 038
    anexos: erpWriter, // 040: a 2ª via em PDF sai pela credencial da integração
    venda: { repo: vendaRepo, pspNome: psp.nome }, // 045
    ...(anonimizacao ? { anonimizacao: anonimizacao.acumulador } : {}), // 016
  }),
  logger,
});
// 040: o worker do outbox resolve o anexo no instante do envio (ERP → Meta),
// e o PDF não encosta em disco nem em coluna nenhuma no caminho
await registerOutboxWorker({ db, boss, gateway, logger, anexos: erpWriter });
await registerOutboxSweeper({ db, boss, gateway, logger, anexos: erpWriter });
await registerDisparoWorker({ db, boss, gateway, logger }); // 013
// 014: emissão no PSP e eventos do webhook
await registerCobrancaEmitirWorker({
  db,
  boss,
  repo: pagamentosRepo,
  psp,
  logger,
  nomeCliente: clientConfig.nome,
  env,
  pixRecebedor: clientConfig.pagamentos.pix ?? null, // 043
});
await registerCobrancaEventoWorker({ db, boss, repo: pagamentosRepo, gateway, env, logger });
// 036: a baixa no ERP roda em fila PRÓPRIA — dentro do evento, um retry por
// instabilidade do TSE reexecutaria `notificarPago` e o cotista receberia
// "pagamento confirmado" de novo
await registerErpBaixaWorker({ db, boss, writer: erpWriter, logger });
// 038: criar + confirmar a reserva no ERP, com read-back por chave natural
await registerErpReservaWorker({ db, boss, writer: reservaWriter, logger });
// 045: pessoa + casal + venda, disparado SÓ pelo pagamento do sinal
await registerErpVendaWorker({
  db,
  boss,
  writer: reservaWriter,
  logger,
  idProdutoPadrao: env.VENDA_ID_PRODUTO,
  idMeioPagamentoSinal: env.VENDA_MEIO_PAGAMENTO_SINAL,
  idMeioPagamentoSaldo: env.VENDA_MEIO_PAGAMENTO_SALDO,
});

const app = buildApp({
  env,
  clientConfig,
  wa: { db, boss },
  console: { auth, executor, registry, provider, templateApi },
  pagamentos: { repo: pagamentosRepo, psp },
});

try {
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  app.log.info(
    {
      cliente: clientConfig.nome,
      simulador: env.DEV_SIMULATOR,
      gateway: env.WA_ACCESS_TOKEN ? 'meta' : 'log-only',
      llm: provider ? provider.modelId : 'não configurado (fallback)',
      // 016: o que fica entre o texto e o provedor — "off" é decisão explícita
      anonimizacao: anonimizacao ? anonimizacao.detectores.join('+') : 'off',
      toolsCatalogo: catalog.list().filter((e) => e.tool.expose).length,
      // 014: confundir sandbox com produção é mandar cobrança de verdade
      psp: psp.nome === 'asaas' ? `asaas-${psp.ambiente}` : 'simulado',
      pagamentos: clientConfig.modulos.pagamentos,
      // 043: sem modelo ou sem recebedor, janela fechada volta a virar ticket
      templateCobranca:
        env.WA_TEMPLATE_COBRANCA_PIX && clientConfig.pagamentos.pix
          ? env.WA_TEMPLATE_COBRANCA_PIX
          : 'off',
      sdr: clientConfig.modulos.sdr ? `alçada ${env.SDR_DESCONTO_MAX_BPS} bps` : false, // 015
      reserva: clientConfig.modulos.reserva
        ? `teto taxa ${env.RESERVA_TETO_TAXA_SEM_HITL_CENTAVOS} centavos`
        : false, // 038
      venda: clientConfig.modulos.sdr
        ? `sinal ${env.VENDA_SINAL_CENTAVOS} centavos, produto ${env.VENDA_ID_PRODUTO}`
        : false, // 045
    },
    'server no ar',
  );
} catch (err) {
  app.log.error(err, 'falha no boot');
  process.exit(1);
}
