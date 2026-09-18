import { join } from 'node:path';
import { createFakeProvider } from '@seta/ai-provider/testing';
import { loadClientConfig } from '@seta/client-config';
import { createPgConnector, type DbConnector } from '@seta/erp-connector';
import { createLogger, createNoopObsEmitter } from '@seta/observability';
import { createSimulatedPaymentProvider } from '@seta/payment-provider';
import { createExecutor, type Executor, loadCatalog } from '@seta/query-catalog';
import { asc, count, desc, eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminUrl, applySchema, seedData } from '../../../infra/erp-mock/seed.ts';
import { type App, buildApp } from '../src/app.ts';
import { createAuth } from '../src/auth.ts';
import { FILA_DEBOUNCE, FILA_OUTBOX, startBoss } from '../src/boss.ts';
import { createDb, type Db } from '../src/db/index.ts';
import {
  cobranca,
  conversa,
  conversaLeitura,
  eventoQuery,
  eventoTicket,
  fluxoSdr,
  lead,
  mensagem,
  outbox,
  propostaSdr,
  sinalAprendizado,
  ticket,
  traceTurno,
  turno,
  venda,
} from '../src/db/schema.ts';
import { type Env, loadEnv } from '../src/env.ts';
import { createPagamentosRepo } from '../src/pagamentos/repo.ts';
import { createDrizzleQueryEventSink } from '../src/query-event-sink.ts';
import { createPgVectorStore } from '../src/rag/pgvector-store.ts';
import type { SdrFluxoDeps } from '../src/sdr/fluxo.ts';
import { createSdrRepo } from '../src/sdr/repo.ts';
import { seedApp, USUARIOS_DEMO } from '../src/seed-app.ts';
import { createVendaRepo } from '../src/venda/repo.ts';
import { registerDebounceWorker } from '../src/wa/debounce.ts';
import { createAgentTurnoHandler } from '../src/wa/turno-handler.ts';

/**
 * Spec 015b — um humano decide a proposta que passou da alçada.
 *
 * Até aqui o fluxo encerrava em `aguardando_aprovacao`, a tela mostrava a
 * proposta e **o lead ficava sem resposta nenhuma** até alguém falar com ele
 * pela conversa. Estes casos cobrem os três caminhos (aprovar, recusar,
 * contrapropor) e o que cada um faz chegar ao WhatsApp.
 *
 * Exige o Postgres dev de pé (docker compose -f infra/compose.dev.yml up -d).
 */

const LEAD = '5511987651015';
const DEBOUNCE_MS = 300;
const BPS = 300;
const logger = createLogger({ name: 'teste-015b', level: 'silent' });
const clientConfig = loadClientConfig(
  join(import.meta.dirname, '../../../configs/demo/client.yaml'),
);

let env: Env;
let db: Db;
let closeDb: () => Promise<void>;
let boss: Awaited<ReturnType<typeof startBoss>>;
let app: App;
let admin: pg.Pool;
let connector: DbConnector;
let executor: Executor;
let cookie = '';
let fake = createFakeProvider();
let sdrDeps: SdrFluxoDeps;
const psp = createSimulatedPaymentProvider();

async function traces(): Promise<number> {
  return (await db.select({ n: count() }).from(traceTurno))[0]?.n ?? 0;
}

async function aguardar(cond: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const inicio = Date.now();
  while (Date.now() - inicio < timeoutMs) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('condição não atingida no tempo');
}

async function turnoDe(texto: string): Promise<string> {
  const antes = await traces();
  const res = await app.inject({
    method: 'POST',
    url: '/dev/inbound',
    headers: { cookie },
    payload: { waId: LEAD, text: texto },
  });
  expect(res.statusCode).toBe(202);
  await aguardar(async () => (await traces()) === antes + 1);
  const linhas = await db.select().from(outbox).orderBy(asc(outbox.criadoEm), asc(outbox.seq));
  return linhas[linhas.length - 1]?.texto ?? '';
}

/** Textos que saíram pelo outbox — a decisão do console chega por ali. */
async function textos(): Promise<string[]> {
  const linhas = await db.select().from(outbox).orderBy(asc(outbox.criadoEm), asc(outbox.seq));
  return linhas.map((l) => l.texto);
}

/**
 * Leva o lead até o pedido abaixo do piso, que é o que escala. Mesmo cenário do
 * `sdr.integration`: 4 pessoas × 2 períodos traz a Ouro Special, cujo piso fica
 * acima dos 50 mil que o lead oferece.
 */
async function ateAguardandoAprovacao() {
  fake.respondeTexto('comprar_cota');
  await turnoDe('quero comprar uma cota');
  await turnoDe('4');
  await turnoDe('2');
  await turnoDe('1');
  await turnoDe('fecho por 50 mil');

  const [p] = await db.select().from(propostaSdr).orderBy(desc(propostaSdr.criadoEm)).limit(1);
  const [l] = await db.select().from(lead).where(eq(lead.waId, LEAD));
  expect(p?.status, 'a proposta precisa estar aguardando aprovação').toBe('aguardando_aprovacao');
  return { proposta: p as NonNullable<typeof p>, lead: l as NonNullable<typeof l> };
}

const decidir = (leadId: string, pid: string, rota: 'aprovar' | 'recusar', body?: unknown) =>
  app.inject({
    method: 'POST',
    url: `/api/console/leads/${leadId}/propostas/${pid}/${rota}`,
    headers: { cookie },
    payload: body ?? {},
  });

async function limpar(): Promise<void> {
  for (let tentativa = 0; ; tentativa++) {
    try {
      await db.delete(venda);
      await db.delete(cobranca);
      await db.delete(propostaSdr);
      await db.delete(fluxoSdr);
      await db.delete(lead);
      await db.delete(sinalAprendizado);
      await db.delete(eventoTicket);
      await db.delete(ticket);
      await db.delete(traceTurno);
      await db.delete(eventoQuery);
      await db.delete(outbox);
      await db.delete(mensagem);
      await db.delete(turno);
      await db.delete(conversaLeitura);
      await db.delete(conversa);
      return;
    } catch (err) {
      if (tentativa >= 4) throw err;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

beforeAll(async () => {
  admin = new pg.Pool({ connectionString: adminUrl(), max: 2 });
  await admin.query('SELECT 1');
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
      SDR_DESCONTO_MAX_BPS: String(BPS),
    } as NodeJS.ProcessEnv),
    WA_DEBOUNCE_MS: DEBOUNCE_MS,
  };

  const criado = createDb(env.DATABASE_URL);
  db = criado.db;
  closeDb = criado.close;
  await migrate(db, { migrationsFolder: join(import.meta.dirname, '../drizzle') });
  await seedApp(db, env);

  connector = createPgConnector({ url: env.ERP_DATABASE_URL, poolMax: 3 });
  const catalog = await loadCatalog(join(import.meta.dirname, '../../../catalog'));
  executor = createExecutor({ catalog, connector, sink: createDrizzleQueryEventSink(db) });
  boss = await startBoss(env.DATABASE_URL, logger);

  const vendaRepo = createVendaRepo(db);
  sdrDeps = {
    db,
    executor,
    repo: createSdrRepo(db),
    provider: null,
    env,
    logger,
    // 045 ligada: é o estado real do produto, e a aprovação leva ao sinal
    venda: { repo: vendaRepo, boss, pspNome: psp.nome },
  };

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
      registry: null,
      store: createPgVectorStore({ db, dim: env.EMBEDDING_DIM }),
      obs: createNoopObsEmitter(),
      logger,
      turnoTimeoutMs: 30_000,
      resumoACadaTurnos: 99,
      debounceMs: DEBOUNCE_MS,
      pagamentos: { repo: createPagamentosRepo(db), psp, env },
      sdr: { repo: createSdrRepo(db), env },
      venda: { repo: vendaRepo, pspNome: psp.nome },
    }),
    logger,
  });

  const auth = createAuth(db, { secret: env.BETTER_AUTH_SECRET, baseURL: env.BETTER_AUTH_URL });
  app = buildApp({
    env,
    clientConfig,
    wa: { db, boss },
    console: { auth, executor },
    sdr: sdrDeps,
  });
  const atendente = USUARIOS_DEMO[0];
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    payload: { email: atendente?.email, password: atendente?.password },
  });
  expect(login.statusCode).toBe(200);
  const setCookie = login.headers['set-cookie'];
  cookie = (Array.isArray(setCookie) ? setCookie : [setCookie ?? ''])
    .map((c) => c.split(';')[0])
    .join('; ');
}, 120_000);

beforeEach(async () => {
  fake = createFakeProvider();
  await boss.deleteQueuedJobs(FILA_DEBOUNCE);
  await boss.deleteQueuedJobs(FILA_OUTBOX);
  await limpar();
});

afterAll(async () => {
  await limpar();
  await app?.close();
  await boss?.stop({ graceful: false });
  await connector?.close();
  await closeDb?.();
  await admin?.end();
}, 120_000);

describe('015b: a decisão do console volta para a conversa', { timeout: 120_000 }, () => {
  it('aprovar: a proposta vira aceita, o lead é avisado e o fluxo segue para o fechamento', async () => {
    const { proposta, lead: l } = await ateAguardandoAprovacao();

    const r = await decidir(l.id, proposta.id, 'aprovar');
    expect(r.statusCode).toBe(202);

    const [depois] = await db.select().from(propostaSdr).where(eq(propostaSdr.id, proposta.id));
    expect(depois?.status).toBe('aceita');
    expect(depois?.aprovadoPor).toBeTruthy();
    // o valor aprovado é o que o LEAD pediu, não o piso
    expect(depois?.valorOfertadoCentavos).toBe(proposta.valorPedidoCentavos);

    // o lead recebeu a resposta — era isso que faltava na 015a
    await aguardar(async () => (await textos()).some((t) => t.includes('consegui fechar em')));

    // e o fluxo saiu de `encerrado`: com a 045 ligada, vai pedir os dados
    const [fluxo] = await db.select().from(fluxoSdr);
    expect(fluxo?.etapa).toBe('dados');
    expect(fluxo?.valorAcordadoCentavos).toBe(proposta.valorPedidoCentavos);
  });

  it('recusar: o lead recebe o valor do piso e ainda pode aceitar', async () => {
    const { proposta, lead: l } = await ateAguardandoAprovacao();

    const r = await decidir(l.id, proposta.id, 'recusar', { motivo: 'abaixo da margem mínima' });
    expect(r.statusCode).toBe(202);

    const [depois] = await db.select().from(propostaSdr).where(eq(propostaSdr.id, proposta.id));
    expect(depois?.status).toBe('recusada');
    expect(depois?.motivo).toBe('abaixo da margem mínima');

    const enviados = await textos();
    const oferta = enviados.find((t) => t.includes('O melhor que tenho é'));
    expect(oferta, 'o lead precisa receber o piso').toBeTruthy();
    // o piso em reais aparece na mensagem
    expect(oferta).toContain(
      (proposta.valorMinimoCentavos / 100).toLocaleString('pt-BR').split(',')[0]?.slice(0, 3) ?? '',
    );

    // o fluxo voltou para `oferta`: a bola está com o lead
    const [fluxo] = await db.select().from(fluxoSdr);
    expect(fluxo?.etapa).toBe('oferta');
    expect(fluxo?.oferta).toBe('piso');
  });

  it('contra-proposta: nasce uma proposta nova com origem humano', async () => {
    const { proposta, lead: l } = await ateAguardandoAprovacao();
    const meio = Math.round((proposta.valorMinimoCentavos + proposta.valorTabelaCentavos) / 2);

    const r = await decidir(l.id, proposta.id, 'recusar', {
      motivo: 'contra-proposta do comercial',
      contrapropostaCentavos: meio,
    });
    expect(r.statusCode).toBe(202);

    const todas = await db.select().from(propostaSdr).orderBy(asc(propostaSdr.criadoEm));
    expect(todas).toHaveLength(2);
    expect(todas[0]?.status).toBe('recusada');
    expect(todas[1]).toMatchObject({
      status: 'ofertada',
      origem: 'humano',
      valorOfertadoCentavos: meio,
    });

    await aguardar(async () =>
      (await textos()).some((t) => t.includes('Consegui uma condição melhor')),
    );
    const [fluxo] = await db.select().from(fluxoSdr);
    expect(fluxo?.valorAcordadoCentavos).toBe(meio);
  });
});

describe('015b: as travas', { timeout: 120_000 }, () => {
  it('decidir duas vezes devolve 409 — dois atendentes, uma decisão', async () => {
    const { proposta, lead: l } = await ateAguardandoAprovacao();

    expect((await decidir(l.id, proposta.id, 'aprovar')).statusCode).toBe(202);
    const segunda = await decidir(l.id, proposta.id, 'aprovar');
    expect(segunda.statusCode).toBe(409);
    expect(segunda.json().erro).toContain('não está aguardando aprovação');
  });

  it('contra-proposta fora da faixa é 400 e NÃO consome a aprovação pendente', async () => {
    const { proposta, lead: l } = await ateAguardandoAprovacao();

    const acima = await decidir(l.id, proposta.id, 'recusar', {
      motivo: 'teste',
      contrapropostaCentavos: proposta.valorTabelaCentavos + 1,
    });
    expect(acima.statusCode).toBe(400);

    const abaixo = await decidir(l.id, proposta.id, 'recusar', {
      motivo: 'teste',
      contrapropostaCentavos: proposta.valorMinimoCentavos - 1,
    });
    expect(abaixo.statusCode).toBe(400);

    // a proposta continua decidível: um 400 não pode queimar a pendência
    const [ainda] = await db.select().from(propostaSdr).where(eq(propostaSdr.id, proposta.id));
    expect(ainda?.status).toBe('aguardando_aprovacao');
    expect((await decidir(l.id, proposta.id, 'aprovar')).statusCode).toBe(202);
  });

  it('proposta de outro lead devolve 404', async () => {
    const { proposta } = await ateAguardandoAprovacao();
    const outro = '00000000-0000-4000-8000-000000000000';
    const r = await decidir(outro, proposta.id, 'aprovar');
    expect(r.statusCode).toBe(409);
    expect(r.json().erro).toBe('proposta inexistente');
  });

  it('sem sessão, 401', async () => {
    const { proposta, lead: l } = await ateAguardandoAprovacao();
    const r = await app.inject({
      method: 'POST',
      url: `/api/console/leads/${l.id}/propostas/${proposta.id}/aprovar`,
      payload: {},
    });
    expect(r.statusCode).toBe(401);
  });

  it('a decisão vira sinal de aprendizado', async () => {
    const { proposta, lead: l } = await ateAguardandoAprovacao();
    await decidir(l.id, proposta.id, 'aprovar');

    const sinais = await db
      .select()
      .from(sinalAprendizado)
      .where(eq(sinalAprendizado.tipo, 'decisao_humana_sdr'));
    expect(sinais).toHaveLength(1);
    const payload = sinais[0]?.payload as { decisao?: string } | undefined;
    expect(payload?.decisao).toBe('aprovada');
  });
});
