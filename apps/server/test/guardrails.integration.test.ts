import { join } from 'node:path';
import { TEXTO_TRANSICAO } from '@seta/agent';
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
import { seedApp } from '../src/seed-app.ts';
import { registerDebounceWorker } from '../src/wa/debounce.ts';
import { ticketPermiteBot } from '../src/wa/tickets.ts';
import { createAgentTurnoHandler } from '../src/wa/turno-handler.ts';

/**
 * Critérios da spec 006 (replay determinístico via simulador):
 * desconto → nenhum valor prometido + ticket negociacao_preco; verdicts no trace.
 */

const DEBOUNCE_MS = 400;
const WA_ID = '5511999990001';
const logger = createLogger({ name: 'teste-guardrails', level: 'silent' });

let env: Env;
let db: Db;
let closeDb: () => Promise<void>;
let boss: Awaited<ReturnType<typeof startBoss>>;
let app: App;
let admin: pg.Pool;
let connector: DbConnector;
let executor: Executor;
let fake = createFakeProvider();

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

async function turnoCompleto(texto: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/dev/inbound',
    payload: { waId: WA_ID, text: texto },
  });
  expect(res.statusCode).toBe(202);
  await aguardar(async () => (await db.select({ n: count() }).from(traceTurno))[0]?.n === 1);
  const [trace] = await db.select().from(traceTurno);
  const [linhaOutbox] = await db.select().from(outbox);
  const [t] = await db.select().from(ticket);
  if (!trace) throw new Error('sem trace');
  return { trace, resposta: linhaOutbox?.texto ?? '', ticket: t };
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
  app = buildApp({ env, clientConfig, wa: { db, boss } });
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

describe('critérios spec 006', () => {
  it('replay: "me dá 10% de desconto?" → classificador escala ANTES de responder', async () => {
    fake.respondeTexto('negociar_preco'); // classificador; o agente nem roda
    const { trace, resposta, ticket: t } = await turnoCompleto('me dá 10% de desconto?');

    // nenhum valor prometido: resposta é a mensagem de transição, sem R$ nem %
    expect(resposta).toBe(TEXTO_TRANSICAO);
    expect(resposta).not.toMatch(/R\$|\d\s?%/);
    expect(t?.status).toBe('aguardando_humano');
    expect(t?.motivoEscalonamento).toBe('negociacao_preco');

    const eventos = trace.eventos as { tipo: string; guardrail?: string }[];
    expect(eventos.find((e) => e.tipo === 'verdict')?.guardrail).toBe('classificador_intencao');
    expect(fake.requests).toHaveLength(1); // só a classificação — sem chamada do agente

    // verdict != allow virou sinal_aprendizado (insumo da 009); a escalada também (009)
    const sinais = await db.select().from(sinalAprendizado);
    expect(sinais.filter((sg) => sg.tipo === 'guardrail_verdict')).toHaveLength(1);
    expect(sinais.filter((sg) => sg.tipo === 'escalonamento')).toHaveLength(1);
  }, 20_000);

  it('replay: classificador falha em pegar, mas o draft com desconto é bloqueado no beforeReply', async () => {
    fake
      .respondeTexto('outro') // classificador não detectou
      .respondeTexto('Claro! Te dou 10% de desconto: fica R$ 99,90.'); // draft proibido
    const { trace, resposta, ticket: t } = await turnoCompleto('e aquele desconto camarada?');

    expect(resposta).toBe(TEXTO_TRANSICAO);
    expect(resposta).not.toMatch(/R\$|\d\s?%/);
    expect(t?.status).toBe('aguardando_humano');
    expect(t?.motivoEscalonamento).toBe('negociacao_preco');

    const eventos = trace.eventos as {
      tipo: string;
      guardrail?: string;
      verdict?: { tipo: string; trigger?: string };
      draftDescartado?: string;
    }[];
    const verdict = eventos.find((e) => e.tipo === 'verdict');
    expect(verdict?.guardrail).toBe('preco');
    expect(verdict?.verdict).toMatchObject({ tipo: 'escalate', trigger: 'negociacao_preco' });
    // #34: o draft REAL descartado fica no trace (insumo do correcao_hitl/009)
    expect(verdict?.draftDescartado).toBe('Claro! Te dou 10% de desconto: fica R$ 99,90.');
    expect(eventos.some((e) => e.tipo === 'fallback')).toBe(true);
  }, 20_000);

  it('#34: valor sem "R$" ("1234 reais") também é pego pelo guardrail', async () => {
    fake.respondeTexto('outro').respondeTexto('Consigo fazer por 1234 reais à vista!'); // sem R$, valor órfão
    const { trace, resposta, ticket: t } = await turnoCompleto('quanto fica aquele item?');

    expect(resposta).toBe(TEXTO_TRANSICAO);
    expect(t?.status).toBe('aguardando_humano');
    const eventos = trace.eventos as { tipo: string; guardrail?: string }[];
    expect(eventos.find((e) => e.tipo === 'verdict')?.guardrail).toBe('preco');
  }, 20_000);

  it('valores rastreáveis a tool do turno passam pelo guardrail (boletos com R$)', async () => {
    fake
      .respondeTexto('outro')
      .chamaTool('titulos_abertos', {})
      .enfileira({ content: null, toolCalls: [] }); // substituído abaixo
    // monta a resposta com o valor REAL do primeiro boleto do seed
    fake.chat = ((original) => async (req: Parameters<typeof original>[0]) => {
      const r = await original(req);
      if (r.content === null && r.toolCalls.length === 0) {
        const toolMsg = req.messages.find((m) => m.role === 'tool');
        const rows = (
          JSON.parse(toolMsg?.content ?? '{}') as { rows?: { valor_centavos?: string }[] }
        ).rows;
        const centavos = Number(rows?.[0]?.valor_centavos ?? 0);
        const reais = (centavos / 100).toFixed(2).replace('.', ',');
        return { ...r, content: `Seu próximo boleto é de R$ ${reais}.` };
      }
      return r;
    })(fake.chat.bind(fake));

    const { trace, resposta, ticket: t } = await turnoCompleto('quais boletos tenho em aberto?');
    expect(resposta).toMatch(/^Seu próximo boleto é de R\$ /);
    expect(t?.status ?? 'bot_ativo').toBe('bot_ativo'); // sem escalada
    const eventos = trace.eventos as { tipo: string }[];
    expect(eventos.some((e) => e.tipo === 'verdict')).toBe(false); // allow não registra verdict
  }, 20_000);
});
