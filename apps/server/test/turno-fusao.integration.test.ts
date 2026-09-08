import { join } from 'node:path';
import type { AIProvider } from '@seta/ai-provider';
import { createFakeProvider } from '@seta/ai-provider/testing';
import { loadClientConfig } from '@seta/client-config';
import { createPgConnector, type DbConnector } from '@seta/erp-connector';
import { createLogger, createNoopObsEmitter } from '@seta/observability';
import { createExecutor, type Executor, loadCatalog } from '@seta/query-catalog';
import { asc, count, eq } from 'drizzle-orm';
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
  conversaLeitura,
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
import { createAgentTurnoHandler, MAX_DESCARTES_CONSECUTIVOS } from '../src/wa/turno-handler.ts';

/**
 * Critérios do #46: mensagem que chega DURANTE o processamento é fundida no
 * turno seguinte (uma resposta só), o turno superado fica no trace com os
 * tokens, o teto de descartes evita inanição e `resolver` varre pendentes.
 * Exige Postgres dev.
 */

const DEBOUNCE_MS = 400;
const WA_ID = '5511999990001';
const logger = createLogger({ name: 'teste-fusao', level: 'silent' });

let env: Env;
let db: Db;
let closeDb: () => Promise<void>;
let boss: Awaited<ReturnType<typeof startBoss>>;
let app: App;
let admin: pg.Pool;
let connector: DbConnector;
let executor: Executor;
let fake: AIProvider = createFakeProvider();
let cookieAtendente = '';

const clientConfig = loadClientConfig(
  join(import.meta.dirname, '../../../configs/demo/client.yaml'),
);
const catalog = loadCatalog(join(import.meta.dirname, '../../../catalog'));

async function aguardar(cond: () => Promise<boolean>, timeoutMs = 12_000): Promise<void> {
  const inicio = Date.now();
  while (Date.now() - inicio < timeoutMs) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('condição não atingida no tempo');
}

async function mensagemDoContato(text: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/dev/inbound',
    headers: { cookie: cookieAtendente },
    payload: { waId: WA_ID, text },
  });
  expect(res.statusCode).toBe(202);
}

const contarTraces = async () => (await db.select({ n: count() }).from(traceTurno))[0]?.n ?? 0;
const respostasDoBot = async () =>
  (await db.select().from(outbox)).filter((o) => o.autor === 'bot');

/**
 * Provider-barreira: classificador responde 'outro' na hora; a chamada do
 * GRAFO fica presa até liberar() — a janela exata para injetar a mensagem
 * "que chega durante o processamento".
 */
function providerBarreira(respostaFinal: string) {
  let liberar: () => void = () => {};
  const barreira = new Promise<void>((r) => {
    liberar = r;
  });
  let bloqueado: () => void = () => {};
  const chegouAoGrafo = new Promise<void>((r) => {
    bloqueado = r;
  });
  const provider: AIProvider = {
    modelId: 'barreira-fusao',
    embed: async (textos: readonly string[]) => textos.map(() => new Float32Array(8)),
    async chat(req) {
      const ehClassificador = String(req.messages[0]?.content).startsWith('Classifique');
      if (!ehClassificador) {
        bloqueado();
        await barreira;
      }
      return {
        content: ehClassificador ? 'outro' : respostaFinal,
        toolCalls: [],
        tokensEntrada: 7,
        tokensSaida: 3,
        finishReason: 'stop',
      };
    },
  };
  return { provider, liberar, chegouAoGrafo };
}

/**
 * Roda um turno com mensagem injetada NO MEIO do processamento:
 * msg inicial → grafo bloqueia → chega msgDuranteTurno → libera → o handler
 * decide (descartar/fundir ou responder, conforme o teto).
 */
async function turnoComMensagemNoMeio(msgInicial: string | null, msgDuranteTurno: string) {
  const tracesAntes = await contarTraces();
  const b = providerBarreira(`resposta ao turno ${tracesAntes + 1}`);
  fake = b.provider;
  if (msgInicial !== null) await mensagemDoContato(msgInicial);
  await b.chegouAoGrafo; // grafo em voo (LLM "gerando")
  await mensagemDoContato(msgDuranteTurno); // ← a mensagem do problema 1
  b.liberar();
  await aguardar(async () => (await contarTraces()) > tracesAntes);
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
      EMBEDDING_DIM: '8',
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
  const handlerReal = createAgentTurnoHandler({
    db,
    boss,
    get provider() {
      return fake;
    },
    catalog,
    executor,
    clientConfig,
    registry: null,
    store: createPgVectorStore({ db, dim: env.EMBEDDING_DIM }),
    obs: createNoopObsEmitter(),
    logger,
    turnoTimeoutMs: 30_000,
    resumoACadaTurnos: 99,
    debounceMs: DEBOUNCE_MS,
  });
  await registerDebounceWorker({
    db,
    boss,
    debounceMs: DEBOUNCE_MS,
    ticketGate: (conversaId) => ticketPermiteBot(db, conversaId),
    handler: handlerReal,
    logger,
  });
  let seq = 0;
  await registerOutboxWorker({
    db,
    boss,
    logger,
    gateway: {
      async send() {
        seq += 1;
        return { waMessageId: `wamid.fusao-${seq}` };
      },
    },
  });
  app = buildApp({ env, clientConfig, wa: { db, boss }, console: { auth, executor } });

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
  for (let tentativa = 0; ; tentativa++) {
    try {
      await db.delete(conversaLeitura);
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

describe('#46 — fusão de mensagens que chegam durante o turno', () => {
  it('turno em voo é descartado; o seguinte agrega as duas mensagens; UMA resposta só', async () => {
    await turnoComMensagemNoMeio('quais parcelas tenho em aberto?', 'e as do mês passado?');

    // turno 1 descartado: NADA no outbox e trace marca o motivo (tokens ficam)
    expect(await respostasDoBot()).toHaveLength(0);
    const [trace1] = await db.select().from(traceTurno).orderBy(asc(traceTurno.criadoEm));
    const eventos1 = trace1?.eventos as { tipo: string }[];
    expect(eventos1.some((e) => e.tipo === 'descartado')).toBe(true);
    expect(trace1?.tokensEntrada).toBeGreaterThan(0); // custo real contabilizado

    // o debounce reagendado agrega tudo num turno novo
    fake = createFakeProvider().respondeTexto('outro').respondeTexto('Aqui vão as duas respostas!');
    await aguardar(async () => (await contarTraces()) === 2);
    const turnos = await db.select().from(turno).orderBy(asc(turno.criadoEm));
    expect(turnos).toHaveLength(2);
    expect(turnos[1]?.textoAgregado).toBe('quais parcelas tenho em aberto?\ne as do mês passado?');

    // o contato recebeu UMA resposta, a do turno agregado
    await aguardar(async () => (await respostasDoBot()).length === 1);
    const [resposta] = await respostasDoBot();
    expect(resposta?.turnoId).toBe(turnos[1]?.id);

    // as duas mensagens do contato pertencem ao turno agregado (o superado ficou sem)
    const doTurno2 = (
      await db
        .select()
        .from(mensagem)
        .where(eq(mensagem.turnoId, turnos[1]?.id ?? ''))
    ).filter((m) => m.direcao === 'in');
    expect(doTurno2).toHaveLength(2);
    const [conv] = await db.select().from(conversa).where(eq(conversa.waId, WA_ID));
    expect(conv?.descartesConsecutivos).toBe(0); // resposta enviada zera o contador
  }, 30_000);

  it('teto de descartes: no limite o agente responde MESMO com pendência (sem inanição)', async () => {
    expect(MAX_DESCARTES_CONSECUTIVOS).toBe(2); // o critério de aceite assume 2
    // descarte 1: msg no meio do turno 1
    await turnoComMensagemNoMeio('primeira', 'segunda');
    expect(await respostasDoBot()).toHaveLength(0);
    // descarte 2: msg no meio do turno 2 (agregado)
    await turnoComMensagemNoMeio(null, 'terceira');
    expect(await respostasDoBot()).toHaveLength(0);
    const [conv] = await db.select().from(conversa).where(eq(conversa.waId, WA_ID));
    expect(conv?.descartesConsecutivos).toBe(MAX_DESCARTES_CONSECUTIVOS);

    // turno 3: mensagem chega DE NOVO no meio — mas o teto força a resposta
    await turnoComMensagemNoMeio(null, 'quarta');
    await aguardar(async () => (await respostasDoBot()).length === 1);
    const [depois] = await db.select().from(conversa).where(eq(conversa.waId, WA_ID));
    expect(depois?.descartesConsecutivos).toBe(0);
    // a 'quarta' segue pendente e vira o turno seguinte, como qualquer mensagem nova
    fake = createFakeProvider().respondeTexto('outro').respondeTexto('E sobre a quarta: aqui!');
    await aguardar(async () => (await respostasDoBot()).length === 2);
  }, 40_000);

  it('resolver varre pendentes acumuladas no atendimento (como devolver já fazia)', async () => {
    // escala e assume: bot silenciado
    fake = createFakeProvider().respondeTexto('negociar_preco');
    await mensagemDoContato('me dá um desconto?');
    await aguardar(async () => (await db.select().from(ticket))[0]?.status === 'aguardando_humano');
    const [t] = await db.select().from(ticket);
    const assumir = await app.inject({
      method: 'POST',
      url: `/api/console/ticket/${t?.id}/assumir`,
      headers: { cookie: cookieAtendente },
    });
    expect(assumir.statusCode).toBe(200);

    // contato manda mensagem durante o atendimento humano → fica pendente
    const turnosAntes = (await db.select({ n: count() }).from(turno))[0]?.n ?? 0;
    await mensagemDoContato('aproveita e me fala meu saldo');
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS * 3));
    expect((await db.select({ n: count() }).from(turno))[0]?.n).toBe(turnosAntes); // gate segurou

    // resolver → bot reativado E pendentes varridas SEM o contato escrever de novo
    fake = createFakeProvider().respondeTexto('outro').respondeTexto('Seu saldo está aqui!');
    const resolver = await app.inject({
      method: 'POST',
      url: `/api/console/ticket/${t?.id}/resolver`,
      headers: { cookie: cookieAtendente },
    });
    expect(resolver.statusCode).toBe(200);
    await aguardar(
      async () => ((await db.select({ n: count() }).from(turno))[0]?.n ?? 0) > turnosAntes,
    );
    const turnos = await db.select().from(turno).orderBy(asc(turno.criadoEm));
    expect(turnos.at(-1)?.textoAgregado).toBe('aproveita e me fala meu saldo');
  }, 30_000);
});
