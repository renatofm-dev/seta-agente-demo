import { join } from 'node:path';
import { createFakeProvider } from '@seta/ai-provider/testing';
import { loadClientConfig } from '@seta/client-config';
import { createPgConnector, type DbConnector } from '@seta/erp-connector';
import { createLogger, createNoopObsEmitter } from '@seta/observability';
import { createExecutor, type Executor, loadCatalog } from '@seta/query-catalog';
import { count } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminUrl, applySchema, seedData } from '../../../infra/erp-mock/seed.ts';
import { type App, buildApp } from '../src/app.ts';
import { createAuth } from '../src/auth.ts';
import { FILA_DEBOUNCE, FILA_OUTBOX, startBoss } from '../src/boss.ts';
import { createDb, type Db } from '../src/db/index.ts';
import {
  conversa,
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
import { createDrizzleQueryEventSink } from '../src/query-event-sink.ts';
import { createPgVectorStore } from '../src/rag/pgvector-store.ts';
import { seedApp, USUARIOS_DEMO } from '../src/seed-app.ts';
import { registerDebounceWorker } from '../src/wa/debounce.ts';
import { registerOutboxWorker } from '../src/wa/outbox.ts';
import { ticketPermiteBot } from '../src/wa/tickets.ts';
import { createAgentTurnoHandler } from '../src/wa/turno-handler.ts';

/**
 * Critérios da spec 007: escalada→fila, assumir silencia o bot (sem turno),
 * devolver reativa, transições inválidas bloqueadas, sinal correcao_hitl.
 * Exige Postgres dev.
 */

const DEBOUNCE_MS = 400;
const WA_ID = '5511999990001'; // vinculado ao cliente 1 no contatos.yaml

const logger = createLogger({ name: 'teste-hitl', level: 'silent' });
let env: Env;
let db: Db;
let closeDb: () => Promise<void>;
let boss: Awaited<ReturnType<typeof startBoss>>;
let app: App;
let admin: pg.Pool;
let connector: DbConnector;
let executor: Executor;
let fake = createFakeProvider();
let cookieAtendente = '';

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

const contarTurnos = async () => (await db.select({ n: count() }).from(turno))[0]?.n ?? 0;

async function mensagemDoContato(text: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/dev/inbound',
    payload: { waId: WA_ID, text },
  });
  expect(res.statusCode).toBe(202);
}

async function apiConsole(method: 'GET' | 'POST', url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: { cookie: cookieAtendente },
    ...(payload !== undefined ? { payload } : {}),
  });
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
      EMBEDDING_DIM: '8', // fake provider embeda em 8 dims
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
  const auth = createAuth(db, { secret: env.BETTER_AUTH_SECRET, baseURL: env.BETTER_AUTH_URL });

  boss = await startBoss(env.DATABASE_URL, logger);
  await registerDebounceWorker({
    db,
    boss,
    debounceMs: DEBOUNCE_MS,
    ticketGate: (conversaId) => ticketPermiteBot(db, conversaId),
    handler: createAgentTurnoHandler({
      db,
      boss,
      get provider() {
        return fake;
      },
      catalog,
      executor,
      clientConfig,
      registry: null, // skills fora destes cenários (009 tem suíte própria)
      store: createPgVectorStore({ db, dim: env.EMBEDDING_DIM }),
      obs: createNoopObsEmitter(),
      logger,
      turnoTimeoutMs: 30_000,
      resumoACadaTurnos: 99,
    }),
    logger,
  });
  let seqEnvio = 0;
  await registerOutboxWorker({
    db,
    boss,
    logger,
    gateway: {
      async send() {
        seqEnvio += 1;
        return { waMessageId: `wamid.hitl-${seqEnvio}` };
      },
    },
  });
  app = buildApp({ env, clientConfig, wa: { db, boss }, console: { auth, executor } });

  // login do atendente seedado → cookie de sessão para a API do console
  const atendente = USUARIOS_DEMO[0];
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    payload: { email: atendente?.email, password: atendente?.password },
  });
  expect(login.statusCode).toBe(200);
  const setCookie = login.headers['set-cookie'];
  cookieAtendente = (Array.isArray(setCookie) ? setCookie : [setCookie ?? ''])
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

describe('critérios spec 007 (fluxo HITL completo)', () => {
  it('escalada → fila; assumir silencia o bot; responder gera sinal; devolver reativa', async () => {
    // 1) contato pede desconto → agente escala
    fake
      .respondeTexto('outro') // classificador (o fluxo testado aqui é a escalada via tool)
      .chamaTool('escalar_para_humano', { motivo: 'pedido de desconto' })
      .respondeTexto('Entendi! Vou te passar para um atendente.');
    await mensagemDoContato('consegue me dar 20% de desconto no chopp?');
    await aguardar(async () => (await db.select().from(ticket))[0]?.status === 'aguardando_humano');

    const [escalado] = await db.select().from(ticket);
    expect(escalado?.motivoEscalonamento).toBe('pedido de desconto');

    // aparece na fila do console
    const inbox = await apiConsole('GET', '/api/console/inbox');
    expect(inbox.statusCode).toBe(200);
    expect(inbox.json().aguardando).toHaveLength(1);
    expect(inbox.json().aguardando[0].motivoEscalonamento).toBe('pedido de desconto');

    // 2) assumir → humano_ativo
    const ticketId = escalado?.id ?? '';
    expect((await apiConsole('POST', `/api/console/ticket/${ticketId}/assumir`)).statusCode).toBe(
      200,
    );

    // 3) mensagem do contato durante humano_ativo NÃO gera turno (critério)
    const turnosAntes = await contarTurnos();
    await mensagemDoContato('e aí, consegue?');
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS * 3));
    expect(await contarTurnos()).toBe(turnosAntes);

    // 4) primeira resposta do atendente → sinal correcao_hitl com o par
    const resposta = await apiConsole('POST', `/api/console/ticket/${ticketId}/responder`, {
      texto: 'Oi! Desconto acima de tabela precisa de aprovação — te retorno em instantes.',
      chave: 'teste-chave-12345',
    });
    expect(resposta.statusCode).toBe(202);

    const sinais = await db.select().from(sinalAprendizado);
    const correcoes = sinais.filter((sg) => sg.tipo === 'correcao_hitl');
    expect(correcoes).toHaveLength(1);
    const payload = correcoes[0]?.payload as {
      draftBot: string;
      respostaHumano: string;
      motivoEscalonamento: string;
    };
    expect(payload.draftBot).toBe('Entendi! Vou te passar para um atendente.');
    expect(payload.respostaHumano).toMatch(/aprovação/);
    expect(payload.motivoEscalonamento).toBe('pedido de desconto');

    // segunda resposta NÃO duplica o sinal
    await apiConsole('POST', `/api/console/ticket/${ticketId}/responder`, {
      texto: 'Novidades em breve!',
      chave: 'teste-chave-67890',
    });
    expect(
      (await db.select().from(sinalAprendizado)).filter((sg) => sg.tipo === 'correcao_hitl'),
    ).toHaveLength(1);

    // resposta do atendente sai pela outbox com autor correto
    await aguardar(async () =>
      (await db.select().from(mensagem)).some((m) => m.autor === 'atendente'),
    );

    // 5) devolver ao bot → mensagens pendentes viram turno (bot reativado)
    fake
      .respondeTexto('outro')
      .respondeTexto('Sobre sua pergunta anterior: sim, consigo te ajudar!');
    expect((await apiConsole('POST', `/api/console/ticket/${ticketId}/devolver`)).statusCode).toBe(
      200,
    );
    await aguardar(async () => (await contarTurnos()) > turnosAntes);
    const [t2] = await db.select().from(ticket);
    expect(t2?.status).toBe('bot_ativo');
  }, 30_000);

  it('transições inválidas via API → 409 sem efeito', async () => {
    fake.respondeTexto('outro').respondeTexto('Olá! Como posso ajudar?');
    await mensagemDoContato('oi');
    await aguardar(async () => (await contarTurnos()) === 1);
    const [t] = await db.select().from(ticket);
    expect(t?.status).toBe('bot_ativo');

    // assumir um ticket que não está aguardando é transição inválida
    const res = await apiConsole('POST', `/api/console/ticket/${t?.id}/assumir`);
    expect(res.statusCode).toBe(409);
    expect((await db.select().from(ticket))[0]?.status).toBe('bot_ativo');
  }, 20_000);

  it('API do console exige sessão', async () => {
    const semCookie = await app.inject({ method: 'GET', url: '/api/console/inbox' });
    expect(semCookie.statusCode).toBe(401);
  });

  it('ticket resolvido reabre com nova mensagem do contato', async () => {
    fake.respondeTexto('outro').respondeTexto('Certo!');
    await mensagemDoContato('primeira');
    await aguardar(async () => (await contarTurnos()) === 1);
    // resolve na marra: bot_ativo → resolvido (transição válida pelo próprio sistema)
    const [t] = await db.select().from(ticket);
    const resolver = await apiConsole('POST', `/api/console/ticket/${t?.id}/resolver`);
    expect(resolver.statusCode).toBe(200);

    fake.respondeTexto('outro').respondeTexto('Oi de novo!');
    await mensagemDoContato('voltei');
    await aguardar(async () => (await contarTurnos()) === 2);
    expect((await db.select().from(ticket))[0]?.status).toBe('bot_ativo');
  }, 20_000);
});
