import { join } from 'node:path';
import { createFakeProvider } from '@seta/ai-provider/testing';
import { loadClientConfig } from '@seta/client-config';
import { TEXTO_METODO } from '@seta/cobranca';
import { createPgConnector, type DbConnector } from '@seta/erp-connector';
import { createLogger, createNoopObsEmitter } from '@seta/observability';
import { createSimulatedPaymentProvider } from '@seta/payment-provider';
import { createExecutor, type Executor, loadCatalog } from '@seta/query-catalog';
import {
  type OutboundTemplate,
  signBody,
  type TemplateApi,
  type TemplateDef,
  type TemplateStatus,
} from '@seta/wa-meta';
import { asc, count, eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminUrl, applySchema, seedData } from '../../../infra/erp-mock/seed.ts';
import { type App, buildApp } from '../src/app.ts';
import { createAuth } from '../src/auth.ts';
import {
  FILA_COBRANCA_EMITIR,
  FILA_COBRANCA_EVENTO,
  FILA_DEBOUNCE,
  FILA_DISPARO,
  FILA_OUTBOX,
  startBoss,
} from '../src/boss.ts';
import { createDb, type Db } from '../src/db/index.ts';
import {
  cobranca,
  cobrancaTitulo,
  conversa,
  conversaLeitura,
  disparo,
  disparoDestinatario,
  eventoPsp,
  eventoQuery,
  eventoTicket,
  fluxoCobranca,
  fluxoSdr,
  lead,
  mensagem,
  modeloMensagem,
  outbox,
  pagamento,
  propostaSdr,
  pspCliente,
  sinalAprendizado,
  ticket,
  traceTurno,
  turno,
} from '../src/db/schema.ts';
import { type Env, loadEnv } from '../src/env.ts';
import { createExecutorConciliado } from '../src/pagamentos/conciliacao.ts';
import { registerCobrancaEmitirWorker } from '../src/pagamentos/emitir.ts';
import { registerCobrancaEventoWorker } from '../src/pagamentos/eventos.ts';
import { createPagamentosRepo } from '../src/pagamentos/repo.ts';
import { createDrizzleQueryEventSink } from '../src/query-event-sink.ts';
import { createPgVectorStore } from '../src/rag/pgvector-store.ts';
import { hojeNoFuso, type RelatorioCampanhas, somarDias } from '../src/relatorios-routes.ts';
import { seedApp, USUARIOS_DEMO } from '../src/seed-app.ts';
import { registerDebounceWorker } from '../src/wa/debounce.ts';
import { registerDisparoWorker } from '../src/wa/disparo.ts';
import { ticketPermiteBot } from '../src/wa/tickets.ts';
import { createAgentTurnoHandler } from '../src/wa/turno-handler.ts';

/**
 * Spec 017 — relatório de campanhas: o funil da 013 cruzado com resposta,
 * cobrança e pagamento (014) dentro da janela de atribuição, contra a meta de
 * conversão. Cenário inteiro pelo simulador: gateway fake, LLM fake (só o
 * classificador), PSP simulado. Exige Postgres dev.
 */

const DEBOUNCE_MS = 300;
const WA_EM_DIA = '5511999990001'; // contrato 10001: em dia
const WA_INADIMPLENTE = '5511999990002'; // contrato 10002: parcelas vencidas
const WA_DISTRATO = '5511999990003'; // contrato 10003: usado como "número que falha"
const logger = createLogger({ name: 'teste-relatorio', level: 'silent' });

let env: Env;
let db: Db;
let closeDb: () => Promise<void>;
let boss: Awaited<ReturnType<typeof startBoss>>;
let app: App;
let admin: pg.Pool;
let connector: DbConnector;
let executor: Executor;
let fake = createFakeProvider();
let cookie = '';
const psp = createSimulatedPaymentProvider();

const clientConfig = loadClientConfig(
  join(import.meta.dirname, '../../../configs/demo/client.yaml'),
);
const catalog = loadCatalog(join(import.meta.dirname, '../../../catalog'));

const templateApiFake = {
  statusPorNome: new Map<string, { status: TemplateStatus; motivo?: string }>(),
  api: {
    async criar(def: TemplateDef) {
      return { metaId: `meta-${def.nome}`, status: 'pendente' as const };
    },
    async listar() {
      return [...templateApiFake.statusPorNome.entries()].map(([nome, s]) => ({
        metaId: `meta-${nome}`,
        nome,
        idioma: 'pt_BR',
        categoria: 'utility',
        status: s.status,
        motivoRejeicao: s.motivo ?? null,
      }));
    },
  } satisfies TemplateApi,
};

const gatewayFake = {
  falhar: new Set<string>(),
  seq: 0,
  gateway: {
    async send() {
      gatewayFake.seq += 1;
      return { waMessageId: `wamid.txt-${gatewayFake.seq}` };
    },
    async sendTemplate(msg: OutboundTemplate) {
      if (gatewayFake.falhar.has(msg.to)) throw new Error('Graph API 400: numero bloqueado');
      gatewayFake.seq += 1;
      return { waMessageId: `wamid.tpl-${gatewayFake.seq}` };
    },
  },
};

async function aguardar(cond: () => Promise<boolean>, timeoutMs = 12_000): Promise<void> {
  const inicio = Date.now();
  while (Date.now() - inicio < timeoutMs) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('condição não atingida no tempo');
}

async function apiConsole(method: 'GET' | 'POST', url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: { cookie },
    ...(payload !== undefined ? { payload } : {}),
  });
}

async function modeloAprovado(nome: string, corpo: string) {
  const criar = await apiConsole('POST', '/api/console/modelos', { nome, corpo });
  expect(criar.statusCode).toBe(201);
  templateApiFake.statusPorNome.set(nome, { status: 'aprovado' });
  expect((await apiConsole('POST', '/api/console/modelos/sincronizar')).statusCode).toBe(200);
  return criar.json().modelo as { id: string };
}

async function campanha(corpo: {
  modeloId: string;
  waIds: string[];
  nome?: string;
  metaConversaoBps?: number;
}) {
  const antes = (await db.select({ n: count() }).from(disparo))[0]?.n ?? 0;
  const res = await apiConsole('POST', '/api/console/disparos', { variaveis: [], ...corpo });
  expect(res.statusCode).toBe(202);
  const { disparoId } = res.json() as { disparoId: string };
  await aguardar(
    async () =>
      (await db.select({ n: count() }).from(disparo).where(eq(disparo.status, 'concluido')))[0]
        ?.n ===
      antes + 1,
  );
  return disparoId;
}

/** Status da Meta pelo webhook assinado (delivered/read) para um destinatário. */
async function statusWebhook(waMessageId: string, status: 'delivered' | 'read') {
  const corpo = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: { statuses: [{ id: waMessageId, status }] } }] }],
  });
  const res = await app.inject({
    method: 'POST',
    url: '/webhook',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': signBody(corpo, env.WA_APP_SECRET),
    },
    payload: corpo,
  });
  expect(res.statusCode).toBe(200);
}

async function traces(): Promise<number> {
  return (await db.select({ n: count() }).from(traceTurno))[0]?.n ?? 0;
}

async function turnoDe(waId: string, text: string): Promise<string[]> {
  const antes = await traces();
  const res = await app.inject({
    method: 'POST',
    url: '/dev/inbound',
    headers: { cookie },
    payload: { waId, text },
  });
  expect(res.statusCode).toBe(202);
  await aguardar(async () => (await traces()) === antes + 1);
  const linhas = await db.select().from(outbox).orderBy(asc(outbox.criadoEm), asc(outbox.seq));
  return linhas.map((l) => l.texto);
}

/** "quero pagar" → 1ª parcela → PIX → sim → cobrança emitida → pagamento simulado. */
async function pagar(waId: string) {
  fake = createFakeProvider().respondeTexto('pagar');
  const lista = await turnoDe(waId, 'quero pagar');
  expect(lista[lista.length - 1]).toContain('Qual você quer pagar');
  const metodo = await turnoDe(waId, '1');
  expect(metodo[metodo.length - 1]).toBe(TEXTO_METODO);
  const confirma = await turnoDe(waId, '2');
  expect(confirma[confirma.length - 1]).toContain('Posso gerar o pagamento?');
  await turnoDe(waId, 'sim');
  await aguardar(async () => (await db.select().from(cobranca))[0]?.status === 'emitida');
  const [c] = await db.select().from(cobranca);
  if (!c) throw new Error('sem cobrança');
  const sim = await apiConsole('POST', `/api/console/cobrancas/${c.id}/simular-pagamento`);
  expect(sim.statusCode).toBe(202);
  await aguardar(async () => (await db.select().from(cobranca))[0]?.status === 'paga');
  expect(await db.select().from(pagamento)).toHaveLength(1);
  return c;
}

async function relatorio(qs: string): Promise<RelatorioCampanhas> {
  const res = await apiConsole('GET', `/api/console/relatorios/campanhas?${qs}`);
  expect(res.statusCode).toBe(200);
  return res.json() as RelatorioCampanhas;
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
  const repo = createPagamentosRepo(db);
  executor = createExecutorConciliado(
    createExecutor({ catalog, connector, sink: createDrizzleQueryEventSink(db) }),
    repo,
  );
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
      pagamentos: {
        repo,
        psp,
        get env() {
          return env;
        },
      },
    }),
    logger,
  });
  await registerDisparoWorker({ db, boss, gateway: gatewayFake.gateway, logger });
  await registerCobrancaEmitirWorker({
    db,
    boss,
    repo,
    psp,
    logger,
    nomeCliente: clientConfig.nome,
  });
  await registerCobrancaEventoWorker({
    db,
    boss,
    repo,
    gateway: gatewayFake.gateway,
    env,
    logger,
  });

  app = buildApp({
    env,
    clientConfig,
    wa: { db, boss },
    console: { auth, executor, templateApi: templateApiFake.api },
    pagamentos: { repo, psp },
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
}, 60_000);

beforeEach(async () => {
  fake = createFakeProvider();
  templateApiFake.statusPorNome.clear();
  gatewayFake.falhar.clear();
  gatewayFake.seq = 0;
  for (const fila of [
    FILA_DEBOUNCE,
    FILA_DISPARO,
    FILA_OUTBOX,
    FILA_COBRANCA_EMITIR,
    FILA_COBRANCA_EVENTO,
  ]) {
    await boss.deleteQueuedJobs(fila);
  }
  for (let tentativa = 0; ; tentativa++) {
    try {
      await db.delete(pagamento);
      await db.delete(cobrancaTitulo);
      await db.delete(fluxoCobranca);
      await db.delete(cobranca);
      await db.delete(eventoPsp);
      await db.delete(pspCliente);
      // o banco de teste é compartilhado com a suíte do SDR (015a)
      await db.delete(propostaSdr);
      await db.delete(fluxoSdr);
      await db.delete(lead);
      await db.delete(disparoDestinatario);
      await db.delete(disparo);
      await db.delete(modeloMensagem);
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

describe('spec 017 — relatório de campanhas', () => {
  it('funil completo: 3 destinatários, 2 entregues, 2 respostas, 1 cobrança, 1 paga ⇒ conversão 50% acima da meta de 30%', async () => {
    const modelo = await modeloAprovado('lembrete_v1', 'Olá! Consta uma parcela em aberto.');
    gatewayFake.falhar.add(WA_DISTRATO);
    const id = await campanha({
      modeloId: modelo.id,
      waIds: [WA_EM_DIA, WA_INADIMPLENTE, WA_DISTRATO],
      nome: 'Lembrete set/26',
    });

    const dests = await db.select().from(disparoDestinatario);
    const inad = dests.find((d) => d.waId === WA_INADIMPLENTE);
    const emDia = dests.find((d) => d.waId === WA_EM_DIA);
    expect(dests.find((d) => d.waId === WA_DISTRATO)?.status).toBe('falha');
    await statusWebhook(inad?.waMessageId ?? '', 'read');
    await statusWebhook(emDia?.waMessageId ?? '', 'delivered');

    // em dia responde e o bot atende; não gera cobrança
    fake = createFakeProvider().respondeTexto('outro').respondeTexto('Que bom te ver!');
    await turnoDe(WA_EM_DIA, 'oi, recebi a mensagem de vocês');
    // inadimplente paga a 1ª parcela por PIX
    const cob = await pagar(WA_INADIMPLENTE);

    const rel = await relatorio('janelaDias=30');
    expect(rel.filtros).toMatchObject({ janelaDias: 30, metaGlobalBps: 3000, competencia: null });
    expect(rel.campanhas).toHaveLength(1);
    const c = rel.campanhas[0];
    expect(c).toMatchObject({
      id,
      nome: 'Lembrete set/26',
      modelo: 'lembrete_v1',
      status: 'concluido',
      metaBps: 3000,
      destinatarios: 3,
      enviadas: 3,
      entregues: 2,
      lidas: 1,
      falhas: 1,
      responderam: 2,
      cobrancas: 1,
      pagas: 1,
      escaladas: 0,
      conversaoBps: 5000,
      valorRecuperadoCentavos: cob.valorCentavos,
    });
    expect(c?.competencia).toBe(hojeNoFuso().slice(0, 7));
    expect(c?.medianaHorasPagamento).not.toBeNull();
    expect(rel.totais).toMatchObject({
      campanhas: 1,
      entregues: 2,
      pagas: 1,
      conversaoBps: 5000,
      metaBps: 3000,
      valorRecuperadoCentavos: cob.valorCentavos,
    });
    expect(rel.anterior.totais.campanhas).toBe(0);
    expect(rel.anterior.ate).toBe(somarDias(rel.filtros.de, -1));
    expect(rel.opcoes).toEqual({ competencias: [c?.competencia], modelos: ['lembrete_v1'] });

    // a listagem da 013 passa a expor nome e meta própria (null ⇒ global)
    const lista = await apiConsole('GET', '/api/console/disparos');
    expect(lista.json().disparos[0]).toMatchObject({
      nome: 'Lembrete set/26',
      meta_conversao_bps: null,
    });

    // competência sem campanha ⇒ tudo zerado, sem erro
    const vazio = await relatorio('competencia=2020-01&de=2020-01-01&ate=2020-01-31');
    expect(vazio.campanhas).toEqual([]);
    expect(vazio.totais).toMatchObject({ campanhas: 0, entregues: 0, conversaoBps: null });
  }, 60_000);

  it('janela de atribuição e "a última campanha leva o crédito"; meta própria sobrescreve a global', async () => {
    const modelo = await modeloAprovado('lembrete_v1', 'Olá!');
    // campanha A, enviada há 40 dias
    const a = await campanha({ modeloId: modelo.id, waIds: [WA_INADIMPLENTE], nome: 'A' });
    await db.execute(
      sql`UPDATE disparo SET criado_em = now() - interval '40 days' WHERE id = ${a}`,
    );
    await db.execute(
      sql`UPDATE mensagem SET criado_em = now() - interval '40 days' WHERE autor = 'campanha'`,
    );
    // campanha B, agora, ao mesmo número, com meta própria de 10%
    const b = await campanha({
      modeloId: modelo.id,
      waIds: [WA_INADIMPLENTE],
      nome: 'B',
      metaConversaoBps: 1000,
    });
    const destB = (await db.select().from(disparoDestinatario)).find((d) => d.disparoId === b);
    await statusWebhook(destB?.waMessageId ?? '', 'delivered');
    await pagar(WA_INADIMPLENTE);

    const hoje = hojeNoFuso();
    const de = somarDias(hoje, -60);
    const rel = await relatorio(`janelaDias=60&de=${de}&ate=${hoje}`);
    const porNome = Object.fromEntries(rel.campanhas.map((c) => [c.nome, c]));
    // B chegou ao número entre o envio de A e o pagamento ⇒ só B leva o crédito
    expect(porNome.A).toMatchObject({ responderam: 0, cobrancas: 0, pagas: 0, metaBps: 3000 });
    expect(porNome.B).toMatchObject({
      entregues: 1,
      responderam: 1,
      cobrancas: 1,
      pagas: 1,
      conversaoBps: 10_000,
      metaBps: 1000,
    });
    expect(rel.totais).toMatchObject({ campanhas: 2, pagas: 1, metaBps: 1000 }); // ponderada: só B entregou

    // sem B, a janela decide: 40 dias depois do envio não cabe em 30, cabe em 60
    await db.delete(disparoDestinatario).where(eq(disparoDestinatario.disparoId, b));
    await db.delete(disparo).where(eq(disparo.id, b));
    const em30 = await relatorio(`janelaDias=30&de=${de}&ate=${hoje}`);
    expect(em30.campanhas[0]).toMatchObject({ nome: 'A', pagas: 0, cobrancas: 0, responderam: 0 });
    const em60 = await relatorio(`janelaDias=60&de=${de}&ate=${hoje}`);
    expect(em60.campanhas[0]).toMatchObject({ nome: 'A', pagas: 1, cobrancas: 1, responderam: 1 });
    // A ficou fora do período padrão (últimos 30 dias)
    expect((await relatorio('janelaDias=60')).campanhas).toEqual([]);
  }, 60_000);

  it('valida o período e a janela', async () => {
    const invertido = await apiConsole(
      'GET',
      '/api/console/relatorios/campanhas?de=2026-09-10&ate=2026-09-01',
    );
    expect(invertido.statusCode).toBe(400);
    const longo = await apiConsole(
      'GET',
      '/api/console/relatorios/campanhas?de=2020-01-01&ate=2026-09-01',
    );
    expect(longo.statusCode).toBe(400);
    const inexistente = await apiConsole(
      'GET',
      '/api/console/relatorios/campanhas?de=2026-02-30&ate=2026-03-01',
    );
    expect(inexistente.statusCode).toBe(400);
    const janela = await apiConsole('GET', '/api/console/relatorios/campanhas?janelaDias=45');
    expect(janela.statusCode).toBe(400);
    const semSessao = await app.inject({ method: 'GET', url: '/api/console/relatorios/campanhas' });
    expect(semSessao.statusCode).toBe(401);
  });
});
