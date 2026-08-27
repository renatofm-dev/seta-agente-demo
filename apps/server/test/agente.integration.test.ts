import { join } from 'node:path';
import { createFakeProvider } from '@seta/ai-provider/testing';
import { loadClientConfig } from '@seta/client-config';
import { createPgConnector, type DbConnector } from '@seta/erp-connector';
import { createLogger } from '@seta/observability';
import { createExecutor, type Executor, loadCatalog } from '@seta/query-catalog';
import { count } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminUrl, applySchema, seedData } from '../../../infra/erp-mock/seed.ts';
import { type App, buildApp } from '../src/app.ts';
import { FILA_DEBOUNCE, FILA_OUTBOX, startBoss } from '../src/boss.ts';
import { createDb, type Db } from '../src/db/index.ts';
import { conversa, eventoQuery, mensagem, outbox, traceTurno, turno } from '../src/db/schema.ts';
import { type Env, loadEnv } from '../src/env.ts';
import { createDrizzleQueryEventSink } from '../src/query-event-sink.ts';
import { registerDebounceWorker } from '../src/wa/debounce.ts';
import { createAgentTurnoHandler } from '../src/wa/turno-handler.ts';
import { loadVinculos } from '../src/wa/vinculo.ts';

/**
 * Critérios da spec 005, ponta a ponta VIA SIMULADOR (provider fake determinístico,
 * dados reais do seed da 002 através do catálogo da 003). Exige Postgres dev.
 */

const DEBOUNCE_MS = 400;
// wa_id vinculado ao cliente 1 no configs/demo/contatos.yaml
const WA_ID_VINCULADO = '5511999990001';
const logger = createLogger({ name: 'teste-agente', level: 'silent' });

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
const vinculos = loadVinculos(join(import.meta.dirname, '../../../configs/demo/contatos.yaml'));

async function aguardar(cond: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const inicio = Date.now();
  while (Date.now() - inicio < timeoutMs) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('condição não atingida no tempo');
}

async function enviarPeloSimulador(waId: string, text: string) {
  const res = await app.inject({ method: 'POST', url: '/dev/inbound', payload: { waId, text } });
  expect(res.statusCode).toBe(202);
}

async function aguardarResposta(): Promise<{
  resposta: string;
  trace: typeof traceTurno.$inferSelect;
}> {
  await aguardar(async () => (await db.select({ n: count() }).from(traceTurno))[0]?.n === 1);
  const [trace] = await db.select().from(traceTurno);
  if (!trace) throw new Error('sem trace');
  const [linhaOutbox] = await db.select().from(outbox);
  return { resposta: linhaOutbox?.texto ?? '', trace };
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
    } as NodeJS.ProcessEnv),
    WA_DEBOUNCE_MS: DEBOUNCE_MS,
  };
  const criado = createDb(env.DATABASE_URL);
  db = criado.db;
  closeDb = criado.close;
  await migrate(db, { migrationsFolder: join(import.meta.dirname, '../drizzle') });

  connector = createPgConnector({ url: env.ERP_DATABASE_URL, poolMax: 3 });
  executor = createExecutor({
    catalog,
    connector,
    sink: createDrizzleQueryEventSink(db),
  });

  boss = await startBoss(env.DATABASE_URL, logger);
  await registerDebounceWorker({
    db,
    boss,
    debounceMs: DEBOUNCE_MS,
    handler: createAgentTurnoHandler({
      db,
      boss,
      get provider() {
        return fake;
      },
      catalog,
      executor,
      clientConfig,
      vinculos,
      logger,
      turnoTimeoutMs: 30_000,
      resumoACadaTurnos: 99, // sem sumarização nestes testes
    }),
    logger,
  });
  app = buildApp({ env, clientConfig, wa: { db, boss } });
}, 60_000);

beforeEach(async () => {
  fake = createFakeProvider();
  await db.delete(traceTurno);
  await db.delete(eventoQuery);
  await db.delete(outbox);
  await db.delete(mensagem);
  await db.delete(turno);
  await db.delete(conversa);
  await boss.deleteQueuedJobs(FILA_DEBOUNCE);
  await boss.deleteQueuedJobs(FILA_OUTBOX);
});

afterAll(async () => {
  await app?.close();
  await boss?.stop({ graceful: false });
  await connector?.close();
  await closeDb?.();
  await admin?.end();
});

describe('critérios spec 005 (via simulador)', () => {
  it('pergunta de boletos → tool certa → resposta com dados do seed', async () => {
    fake
      .chamaTool('titulos_abertos', {})
      .respondeTexto('Encontrei seus boletos em aberto! O primeiro vence em breve.');

    await enviarPeloSimulador(WA_ID_VINCULADO, 'quais boletos tenho em aberto?');
    const { resposta, trace } = await aguardarResposta();

    // a tool certa rodou e o RESULTADO REAL DO SEED voltou ao modelo
    const toolResult = fake.requests[1]?.messages.find((m) => m.role === 'tool');
    expect(toolResult?.content).toContain('valor_centavos');
    expect(toolResult?.content).toContain('linha_digitavel');

    expect(resposta).toContain('boletos em aberto');
    expect(trace.fallback).toBe(false);
    const eventos = trace.eventos as { tipo: string; nome?: string }[];
    expect(eventos.map((e) => e.tipo)).toEqual(['contexto', 'llm', 'tool', 'llm']);
    expect(eventos.find((e) => e.tipo === 'tool')?.nome).toBe('titulos_abertos');

    // auditoria do catálogo também registrou a execução
    const [ev] = await db.select().from(eventoQuery);
    expect(ev?.entryId).toBe('financeiro.titulos_abertos');
    expect(ev?.ok).toBe(true);
  }, 20_000);

  it('pergunta sem caminho de dado → admite não saber e oferece humano (replay)', async () => {
    fake
      .chamaTool('buscar_conhecimento', { consulta: 'política de trocas de barril' })
      .respondeTexto(
        'Não encontrei essa informação na nossa base. Quer que eu acione um atendente humano para te ajudar?',
      );

    await enviarPeloSimulador(WA_ID_VINCULADO, 'como funciona a troca de barril retornável?');
    const { resposta, trace } = await aguardarResposta();

    const toolResult = fake.requests[1]?.messages.find((m) => m.role === 'tool');
    expect(toolResult?.content).toBe('{"rows":[],"truncated":false}'); // stub honesto da 008
    expect(resposta).toMatch(/atendente humano/);
    expect(trace.resposta).toBe(resposta);
  }, 20_000);

  it('trace_turno reconstitui a decisão inteira', async () => {
    fake.chamaTool('perfil_cliente', {}).respondeTexto('Você é o Depósito do Andrade!');
    await enviarPeloSimulador(WA_ID_VINCULADO, 'qual meu cadastro?');
    const { trace } = await aguardarResposta();

    const contexto = trace.contexto as { tools: string[]; nMensagensHistorico: number };
    expect(contexto.tools).toContain('titulos_abertos');
    expect(contexto.tools).toContain('escalar_para_humano');
    const eventos = trace.eventos as {
      tipo: string;
      resultado?: { rows: { documento?: string }[] };
    }[];
    const evTool = eventos.find((e) => e.tipo === 'tool');
    // resultado no trace vem MASCARADO (masking aplicado antes do retorno)
    expect(evTool?.resultado?.rows[0]?.documento).toMatch(/^\*\*\./);
    expect(trace.tokensEntrada).toBeGreaterThan(0);
    expect(trace.latenciaMs).toBeGreaterThanOrEqual(0);
    expect(trace.traceId).toMatch(/^[0-9a-f-]{36}$/);
  }, 20_000);

  it('wa_id SEM vínculo: tools de dado recusam e o modelo se explica', async () => {
    fake
      .chamaTool('titulos_abertos', {})
      .respondeTexto('Não consegui localizar seu cadastro. Vou acionar um atendente.');

    await enviarPeloSimulador('5511888880000', 'quais boletos tenho?');
    const { trace } = await aguardarResposta();

    const eventos = trace.eventos as { tipo: string; erro?: string }[];
    const evTool = eventos.find((e) => e.tipo === 'tool');
    expect(evTool?.erro).toMatch(/sem vínculo/);
  }, 20_000);
});
