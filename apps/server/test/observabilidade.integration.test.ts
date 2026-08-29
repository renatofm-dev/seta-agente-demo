import { join } from 'node:path';
import { createFakeProvider } from '@seta/ai-provider/testing';
import { loadClientConfig } from '@seta/client-config';
import { createPgConnector, type DbConnector } from '@seta/erp-connector';
import { createLogger, newTraceId } from '@seta/observability';
import { createExecutor, type Executor, loadCatalog } from '@seta/query-catalog';
import { count, eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminUrl, applySchema, seedData } from '../../../infra/erp-mock/seed.ts';
import { type App, buildApp } from '../src/app.ts';
import { createAuth } from '../src/auth.ts';
import { FILA_DEBOUNCE, FILA_OUTBOX, startBoss } from '../src/boss.ts';
import { createDb, type Db } from '../src/db/index.ts';
import {
  chunk,
  conversa,
  documento,
  eventoEscalonamento,
  eventoGuardrail,
  eventoLlm,
  eventoQuery,
  eventoTicket,
  mensagem,
  outbox,
  sinalAprendizado,
  ticket,
  traceTurno,
  turno,
} from '../src/db/schema.ts';
import { type Env, loadEnv } from '../src/env.ts';
import { createDrizzleObsEmitter } from '../src/obs-emitter.ts';
import { createDrizzleQueryEventSink } from '../src/query-event-sink.ts';
import { createPgVectorStore } from '../src/rag/pgvector-store.ts';
import { seedApp, USUARIOS_DEMO } from '../src/seed-app.ts';
import { registerDebounceWorker } from '../src/wa/debounce.ts';
import { createAgentTurnoHandler } from '../src/wa/turno-handler.ts';

/**
 * Critérios da spec 010: eventos tipados com traceId/ticketId, métricas batendo
 * um cenário controlado, trace reconstituível via API e emissão que nunca
 * derruba o turno.
 */

const DEBOUNCE_MS = 400;
const WA_ID = '5511999990001';
const logger = createLogger({ name: 'teste-obs', level: 'silent' });

let env: Env;
let db: Db;
let closeDb: () => Promise<void>;
let boss: Awaited<ReturnType<typeof startBoss>>;
let app: App;
let admin: pg.Pool;
let connector: DbConnector;
let executor: Executor;
let store: ReturnType<typeof createPgVectorStore>;
let fake = createFakeProvider();
const providerProxy = {
  modelId: 'proxy-fake',
  chat: (req: Parameters<typeof fake.chat>[0]) => fake.chat(req),
  embed: (t: readonly string[]) => fake.embed(t),
};
let cookie = '';

const clientConfig = loadClientConfig(
  join(import.meta.dirname, '../../../configs/demo/client.yaml'),
);
const catalog = loadCatalog(join(import.meta.dirname, '../../../catalog'));

async function aguardar(cond: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const inicio = Date.now();
  while (Date.now() - inicio < timeoutMs) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('condição não atingida no tempo');
}

async function turnoCompleto(texto: string): Promise<void> {
  const antes = (await db.select({ n: count() }).from(traceTurno))[0]?.n ?? 0;
  const res = await app.inject({
    method: 'POST',
    url: '/dev/inbound',
    headers: { cookie: cookie }, // simulador exige sessão (011)
    payload: { waId: WA_ID, text: texto },
  });
  expect(res.statusCode).toBe(202);
  await aguardar(
    async () => ((await db.select({ n: count() }).from(traceTurno))[0]?.n ?? 0) > antes,
  );
}

beforeAll(async () => {
  admin = new pg.Pool({ connectionString: adminUrl(), max: 2 });
  try {
    await admin.query('SELECT 1');
  } catch (err) {
    throw new Error(
      'Postgres dev indisponível — suba com: docker compose -f infra/compose.dev.yml up -d --wait',
      { cause: err },
    );
  }
  await applySchema(admin);
  await seedData(admin);

  env = {
    ...loadEnv({
      DATABASE_URL:
        process.env.DATABASE_URL ?? 'postgres://app_owner:app_owner_dev@localhost:5432/app',
      ERP_DATABASE_URL:
        process.env.ERP_DATABASE_URL ?? 'postgres://erp_ro:erp_ro_dev@localhost:5432/erp_mock',
      LOG_LEVEL: 'silent',
      DEV_SIMULATOR: 'true',
      CONTATOS_PATH: join(import.meta.dirname, '../../../configs/demo/contatos.yaml'),
      SKILLS_SEED_DIR: join(import.meta.dirname, '../../../skills-seed'),
      EMBEDDING_DIM: '8',
      LLM_PRECO_IN_POR_1M: '10',
      LLM_PRECO_OUT_POR_1M: '20',
    } as NodeJS.ProcessEnv),
    WA_DEBOUNCE_MS: DEBOUNCE_MS,
  };
  const criado = createDb(env.DATABASE_URL);
  db = criado.db;
  closeDb = criado.close;
  await migrate(db, { migrationsFolder: join(import.meta.dirname, '../drizzle') });
  await seedApp(db, env);

  connector = createPgConnector({ url: env.ERP_DATABASE_URL, poolMax: 3 });
  executor = createExecutor({ catalog, connector, sink: createDrizzleQueryEventSink(db) });
  store = createPgVectorStore({ db, dim: env.EMBEDDING_DIM });
  await db.delete(chunk);
  await db.delete(documento);
  await store.ensureIndex();
  const auth = createAuth(db, { secret: env.BETTER_AUTH_SECRET, baseURL: env.BETTER_AUTH_URL });

  boss = await startBoss(env.DATABASE_URL, logger);
  await registerDebounceWorker({
    db,
    boss,
    debounceMs: DEBOUNCE_MS,
    handler: createAgentTurnoHandler({
      db,
      boss,
      provider: providerProxy,
      catalog,
      executor,
      clientConfig,
      registry: null,
      store,
      obs: createDrizzleObsEmitter(db, logger), // emissor REAL — é o que está em teste
      logger,
      turnoTimeoutMs: 30_000,
      resumoACadaTurnos: 99,
    }),
    logger,
  });
  app = buildApp({ env, clientConfig, wa: { db, boss }, console: { auth, executor } });

  const atendente = USUARIOS_DEMO[0];
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    payload: { email: atendente?.email, password: atendente?.password },
  });
  expect(res.statusCode).toBe(200);
  const setCookie = res.headers['set-cookie'];
  cookie = (Array.isArray(setCookie) ? setCookie : [setCookie ?? ''])
    .map((c) => c.split(';')[0])
    .join('; ');
}, 60_000);

beforeEach(async () => {
  fake = createFakeProvider();
  await boss.deleteQueuedJobs(FILA_DEBOUNCE);
  await boss.deleteQueuedJobs(FILA_OUTBOX);
  // turno em voo do teste anterior pode gravar trace no meio da limpeza (FK);
  // com as filas já limpas, repetir a limpeza resolve na 2ª tentativa
  for (let tentativa = 0; ; tentativa++) {
    try {
      await db.delete(eventoLlm);
      await db.delete(eventoGuardrail);
      await db.delete(eventoEscalonamento);
      await db.delete(sinalAprendizado);
      await db.delete(eventoTicket);
      await db.delete(ticket);
      await db.delete(traceTurno);
      await db.delete(eventoQuery);
      await db.delete(outbox);
      await db.delete(mensagem);
      await db.delete(turno);
      await db.delete(conversa);
      break;
    } catch (err) {
      if (tentativa >= 4) throw err;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
});

afterAll(async () => {
  await app?.close();
  await boss?.stop({ graceful: false });
  await connector?.close();
  await closeDb?.();
  await admin?.end();
});

async function cenarioControlado(): Promise<void> {
  // turno 1: pergunta de boletos → 1 tool do catálogo + resposta (2 chats no grafo)
  fake
    .respondeTexto('outro')
    .chamaTool('titulos_abertos', {})
    .respondeTexto('Seus boletos em aberto estão aqui!');
  await turnoCompleto('quais boletos tenho em aberto?');

  // turno 2: pedido de desconto → classificador escala antes do grafo
  fake = createFakeProvider().respondeTexto('negociar_preco');
  await turnoCompleto('me dá um descontinho?');

  // emissão é assíncrona: espera os eventos do cenário aterrissarem
  await aguardar(async () => (await db.select().from(eventoEscalonamento)).length === 1);
  await aguardar(async () => (await db.select().from(eventoLlm)).length === 2);
}

describe('critérios spec 010', () => {
  it('eventos tipados com traceId/ticketId; métricas batem o cenário controlado', async () => {
    await cenarioControlado();

    // evento_llm do turno 1 (#30): classificador (10/5) + 2 chats do grafo (20/10)
    const llms = await db.select().from(eventoLlm).orderBy(eventoLlm.criadoEm);
    expect(llms[0]?.modelo).toBe('proxy-fake');
    expect(llms[0]?.tokensEntrada).toBe(30);
    expect(llms[0]?.tokensSaida).toBe(15);
    expect(llms[0]?.traceId).toBeTruthy();
    expect(llms[0]?.turnoId).toBeTruthy();
    // turno 2 (escala pré-grafo): tokens do classificador contam — nada de 0/0
    expect(llms[1]?.tokensEntrada).toBe(10);
    expect(llms[1]?.tokensSaida).toBe(5);

    // turno 2: guardrail de intenção + escalonamento com ticketId preenchido
    const [g] = await db.select().from(eventoGuardrail);
    expect(g?.guardrail).toBe('classificador_intencao');
    expect(g?.verdict).toBe('escalate');
    const [e] = await db.select().from(eventoEscalonamento);
    expect(e?.motivo).toBe('negociacao_preco');
    expect(e?.origem).toBe('intencao');
    expect(e?.ticketId).toBeTruthy();
    const [tk] = await db.select().from(ticket);
    expect(e?.ticketId).toBe(tk?.id);

    // métricas do período batem os números esperados do cenário
    const res = await app.inject({
      method: 'GET',
      url: '/api/console/metricas?dias=7',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const m = res.json();
    expect(m.totalConversas).toBe(1);
    expect(m.totalEscaladas).toBe(1);
    expect(m.taxaResolucaoSemHumano).toBe(0);
    expect(m.escalonamentosPorMotivo).toEqual([{ motivo: 'negociacao_preco', total: 1 }]);
    expect(m.conversasPorDia).toHaveLength(1);
    expect(m.conversasPorDia[0].conversas).toBe(1);
    // tokens (#30): turno 1 = 30/15 (com classificador); turno 2 = 10/5
    expect(m.tokensPorDia).toHaveLength(1);
    expect(m.tokensPorDia[0].entrada).toBe(40);
    expect(m.tokensPorDia[0].saida).toBe(20);
    // custo com preços do env (in=10, out=20 por 1M)
    expect(m.custoTotal).toBeCloseTo((40 / 1e6) * 10 + (20 / 1e6) * 20, 10);
    expect(m.p95TurnoMs).not.toBeNull();
    expect(m.p95QueryMs).not.toBeNull(); // turno 1 rodou query do catálogo
  }, 30_000);

  it('trace viewer: qualquer turno é reconstituível pela API, sem banco na mão', async () => {
    await cenarioControlado();
    const [tk] = await db.select().from(ticket);

    const res = await app.inject({
      method: 'GET',
      url: `/api/console/ticket/${tk?.id}/traces`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const { traces } = res.json();
    expect(traces).toHaveLength(2);

    // turno 1 inteiro: o que entrou, o que rodou, o que saiu, quanto custou
    const t1 = traces[0];
    expect(t1.textoTurno).toBe('quais boletos tenho em aberto?');
    const tipos = t1.eventos.map((e: { tipo: string }) => e.tipo);
    expect(tipos).toEqual(['contexto', 'llm', 'tool', 'llm']);
    const tool = t1.eventos.find((e: { tipo: string }) => e.tipo === 'tool');
    expect(tool.nome).toBe('titulos_abertos');
    expect(tool.resultado.rows.length).toBeGreaterThan(0);
    expect(t1.resposta).toBe('Seus boletos em aberto estão aqui!');
    expect(t1.tokensEntrada).toBe(30); // trace também inclui o classificador (#30)
    expect(t1.latenciaMs).toBeGreaterThanOrEqual(0);

    // #37: paginação — limite=1 devolve só o turno MAIS RECENTE
    const limitado = await app.inject({
      method: 'GET',
      url: `/api/console/ticket/${tk?.id}/traces?limite=1`,
      headers: { cookie },
    });
    expect(limitado.json().traces).toHaveLength(1);
    expect(limitado.json().traces[0].escalado).toBe(true); // o turno 2

    // turno 2: verdict do classificador + escalada visíveis
    const t2 = traces[1];
    const tipos2 = t2.eventos.map((e: { tipo: string }) => e.tipo);
    expect(tipos2).toContain('verdict');
    expect(t2.escalado).toBe(true);
  }, 30_000);

  it('falha de observabilidade não derruba a resposta do turno', async () => {
    // emitter drizzle apontando para um "banco" que sempre falha (sync e async)
    let falhas = 0;
    const dbQuebrado = new Proxy(
      {},
      {
        get: (_alvo, prop) => {
          if (prop === 'insert') {
            return () => {
              falhas += 1;
              throw new Error('observabilidade fora do ar');
            };
          }
          return undefined;
        },
      },
    ) as unknown as Db;
    const handler = createAgentTurnoHandler({
      db,
      boss,
      provider: providerProxy,
      catalog,
      executor,
      clientConfig,
      registry: null,
      store,
      obs: createDrizzleObsEmitter(dbQuebrado, logger),
      logger,
      turnoTimeoutMs: 30_000,
      resumoACadaTurnos: 99,
    });

    const conversaId = newTraceId();
    const turnoId = newTraceId();
    await db.insert(conversa).values({ id: conversaId, waId: '5511999990002' });
    await db.insert(turno).values({ id: turnoId, conversaId, textoAgregado: 'oi, tudo bem?' });
    fake.respondeTexto('outro').respondeTexto('Tudo ótimo! Como posso ajudar?');

    await handler.processar({ id: turnoId, conversaId, textoAgregado: 'oi, tudo bem?' });

    expect(falhas).toBeGreaterThan(0); // o emitter de fato falhou...
    const [saida] = await db.select().from(outbox).where(eq(outbox.conversaId, conversaId));
    expect(saida?.texto).toBe('Tudo ótimo! Como posso ajudar?'); // ...e a resposta saiu
    const [trace] = await db.select().from(traceTurno).where(eq(traceTurno.conversaId, conversaId));
    expect(trace?.fallback).toBe(false); // turno normal, sem fallback de emergência
  }, 20_000);

  it('#30: tokens do RESUMO rolante também entram na conta do turno', async () => {
    const handler = createAgentTurnoHandler({
      db,
      boss,
      provider: providerProxy,
      catalog,
      executor,
      clientConfig,
      registry: null,
      store,
      obs: createDrizzleObsEmitter(db, logger),
      logger,
      turnoTimeoutMs: 30_000,
      resumoACadaTurnos: 1, // resumo roda já no primeiro turno
    });

    const conversaId = newTraceId();
    const turnoId = newTraceId();
    await db.insert(conversa).values({ id: conversaId, waId: '5511999990003' });
    await db.insert(turno).values({ id: turnoId, conversaId, textoAgregado: 'oi de novo' });
    // 3 chamadas: classificador, resposta do grafo e sumarização (10/5 cada)
    fake
      .respondeTexto('outro')
      .respondeTexto('Oi! Tudo certo por aqui.')
      .respondeTexto('Resumo: cliente cumprimentou; sem pendências.');

    await handler.processar({ id: turnoId, conversaId, textoAgregado: 'oi de novo' });

    await aguardar(async () => {
      const [ev] = await db.select().from(eventoLlm).where(eq(eventoLlm.conversaId, conversaId));
      return ev !== undefined;
    });
    const [ev] = await db.select().from(eventoLlm).where(eq(eventoLlm.conversaId, conversaId));
    expect(ev?.tokensEntrada).toBe(30); // 10 (classificador) + 10 (grafo) + 10 (resumo)
    expect(ev?.tokensSaida).toBe(15);
    const [conv] = await db.select().from(conversa).where(eq(conversa.id, conversaId));
    expect(conv?.resumo).toContain('Resumo');
  }, 20_000);
});
