import { join } from 'node:path';
import { TEXTO_TRANSICAO } from '@seta/agent';
import type { AIProvider } from '@seta/ai-provider';
import { createFakeProvider } from '@seta/ai-provider/testing';
import { loadClientConfig } from '@seta/client-config';
import { createPgConnector, type DbConnector } from '@seta/erp-connector';
import { createLogger, createNoopObsEmitter } from '@seta/observability';
import { createExecutor, type Executor, loadCatalog } from '@seta/query-catalog';
import { asc, count } from 'drizzle-orm';
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
import { createAgentTurnoHandler, TEXTO_JA_NA_FILA } from '../src/wa/turno-handler.ts';

/**
 * Critérios do #47: com o ticket em aguardando_humano o bot CONTINUA
 * atendendo (outros assuntos respondidos; tema escalado vira reconhecimento
 * da fila, sem repetir a escalada); humano_ativo silencia; Assumir durante um
 * turno em voo descarta a resposta; correcao_hitl pareia com o trace DA
 * ESCALADA. Exige Postgres dev.
 */

const DEBOUNCE_MS = 400;
const WA_ID = '5511999990001';
const logger = createLogger({ name: 'teste-hitl-fila', level: 'silent' });

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

async function apiConsole(method: 'GET' | 'POST', url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: { cookie: cookieAtendente },
    ...(payload !== undefined ? { payload } : {}),
  });
}

const contarTraces = async () => (await db.select({ n: count() }).from(traceTurno))[0]?.n ?? 0;
const contarTurnos = async () => (await db.select({ n: count() }).from(turno))[0]?.n ?? 0;
const respostasDoBot = async () =>
  (await db.select().from(outbox).orderBy(asc(outbox.criadoEm))).filter((o) => o.autor === 'bot');

/** Escala via classificador e espera o ticket entrar na fila. */
async function escalar(texto: string) {
  const antes = await contarTraces();
  fake = createFakeProvider().respondeTexto('negociar_preco');
  await mensagemDoContato(texto);
  await aguardar(async () => (await db.select().from(ticket))[0]?.status === 'aguardando_humano');
  await aguardar(async () => (await contarTraces()) > antes);
  const [t] = await db.select().from(ticket);
  if (!t) throw new Error('escalada não materializou');
  return t;
}

/** Turno completo do bot (classificador 'outro' + resposta). */
async function turnoDoBot(textoContato: string, respostaBot: string) {
  const antes = await contarTraces();
  const proximo = createFakeProvider().respondeTexto('outro').respondeTexto(respostaBot);
  fake = proximo;
  await mensagemDoContato(textoContato);
  await aguardar(async () => (await contarTraces()) > antes);
  return proximo;
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
      registry: null,
      store: createPgVectorStore({ db, dim: env.EMBEDDING_DIM }),
      obs: createNoopObsEmitter(),
      logger,
      turnoTimeoutMs: 30_000,
      resumoACadaTurnos: 99,
      debounceMs: DEBOUNCE_MS,
    }),
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
        return { waMessageId: `wamid.fila-${seq}` };
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

describe('#47 — bot ativo na fila de humano', () => {
  it('fluxo completo: escala → off-topic respondida → on-topic reconhecida → assumir → silêncio', async () => {
    // 1) escalada normal: transição + ticket na fila
    const t = await escalar('consigo algum desconto?');
    expect((await respostasDoBot()).at(-1)?.texto).toBe(TEXTO_TRANSICAO);

    // 2) pergunta de OUTRO assunto na fila → o bot responde normalmente,
    //    com o contexto da escalada injetado no prompt
    const provider = await turnoDoBot('qual foi meu último chamado?', 'Seu chamado está aberto!');
    await aguardar(async () => (await respostasDoBot()).length === 2);
    expect((await respostasDoBot()).at(-1)?.texto).toBe('Seu chamado está aberto!');
    const system = String(provider.requests[1]?.messages[0]?.content ?? '');
    expect(system).toContain('JÁ FOI ACIONADO');
    expect(system).toContain(t.motivoEscalonamento); // motivo entra no contexto

    // 3) o TEMA ESCALADO volta → reconhecimento da fila, SEM repetir a
    //    escalada e SEM nova transição de ticket
    const transicoesAntes = (await db.select().from(eventoTicket)).length;
    fake = createFakeProvider().respondeTexto('negociar_preco');
    await mensagemDoContato('e aí, me dá logo o desconto');
    await aguardar(async () => (await respostasDoBot()).length === 3);
    expect((await respostasDoBot()).at(-1)?.texto).toBe(TEXTO_JA_NA_FILA);
    expect((await db.select().from(eventoTicket)).length).toBe(transicoesAntes);
    expect((await db.select().from(ticket))[0]?.status).toBe('aguardando_humano');
    const traces = await db.select().from(traceTurno).orderBy(asc(traceTurno.criadoEm));
    expect(traces.at(-1)?.escalado).toBe(false); // reconhecimento não é nova escalada
    expect(traces.at(-1)?.resposta).toBe(TEXTO_JA_NA_FILA);

    // 4) atendente assume → bot silencia de vez (comportamento preservado)
    expect((await apiConsole('POST', `/api/console/ticket/${t.id}/assumir`)).statusCode).toBe(200);
    const turnosAntes = await contarTurnos();
    fake = createFakeProvider().respondeTexto('outro').respondeTexto('não deveria sair');
    await mensagemDoContato('alguém aí?');
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS * 3));
    expect(await contarTurnos()).toBe(turnosAntes); // gate segurou: nem turno nasce
    expect((await respostasDoBot()).length).toBe(3);
  }, 40_000);

  it('corrida do Assumir: resposta do bot em voo é descartada quando o humano assume', async () => {
    const t = await escalar('quero desconto');
    const respostasAntes = (await respostasDoBot()).length;

    // provider-barreira: o grafo trava "gerando" a resposta off-topic
    let liberar: () => void = () => {};
    const barreira = new Promise<void>((r) => {
      liberar = r;
    });
    let bloqueado: () => void = () => {};
    const chegouAoGrafo = new Promise<void>((r) => {
      bloqueado = r;
    });
    fake = {
      modelId: 'barreira-fila',
      embed: async (textos: readonly string[]) => textos.map(() => new Float32Array(8)),
      async chat(req) {
        const ehClassificador = String(req.messages[0]?.content).startsWith('Classifique');
        if (!ehClassificador) {
          bloqueado();
          await barreira;
        }
        return {
          content: ehClassificador ? 'outro' : 'resposta que o humano atropelou',
          toolCalls: [],
          tokensEntrada: 5,
          tokensSaida: 2,
          finishReason: 'stop',
        };
      },
    };
    const tracesAntes = await contarTraces();
    await mensagemDoContato('me fala do meu contrato');
    await chegouAoGrafo;
    // humano assume ENQUANTO o bot gera
    expect((await apiConsole('POST', `/api/console/ticket/${t.id}/assumir`)).statusCode).toBe(200);
    liberar();
    await aguardar(async () => (await contarTraces()) > tracesAntes);

    // nada saiu; o trace registra o descarte pelo humano
    expect((await respostasDoBot()).length).toBe(respostasAntes);
    const traces = await db.select().from(traceTurno).orderBy(asc(traceTurno.criadoEm));
    const eventos = traces.at(-1)?.eventos as { tipo: string; motivo?: string }[];
    const descarte = eventos.find((e) => e.tipo === 'descartado');
    expect(descarte?.motivo).toContain('atendente assumiu');
  }, 30_000);

  it('correcao_hitl pareia com o trace DA ESCALADA, não com o mais recente', async () => {
    const t = await escalar('me dá um desconto?');
    // bot segue conversando na fila — o trace mais recente vira outro assunto
    await turnoDoBot('qual o meu saldo?', 'Resposta off-topic qualquer!');

    expect((await apiConsole('POST', `/api/console/ticket/${t.id}/assumir`)).statusCode).toBe(200);
    const responder = await apiConsole('POST', `/api/console/ticket/${t.id}/responder`, {
      texto: 'Sobre o desconto: consigo aprovar 5% neste caso.',
      chave: 'chave-pareamento-1',
    });
    expect(responder.statusCode).toBe(202);

    const sinais = await db.select().from(sinalAprendizado);
    const correcao = sinais.find((s) => s.tipo === 'correcao_hitl');
    const payload = correcao?.payload as { draftBot: string; traceTurnoId: string };
    const traces = await db.select().from(traceTurno).orderBy(asc(traceTurno.criadoEm));
    const traceEscalada = traces.find((tr) => tr.escalado);
    expect(payload.traceTurnoId).toBe(traceEscalada?.id);
    expect(payload.draftBot).toBe(TEXTO_TRANSICAO); // o rascunho da escalada
    expect(payload.draftBot).not.toBe('Resposta off-topic qualquer!');
  }, 30_000);
});
