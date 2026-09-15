import { join } from 'node:path';
import { loadClientConfig } from '@seta/client-config';
import { createPgConnector, type DbConnector } from '@seta/erp-connector';
import { createLogger, newTraceId } from '@seta/observability';
import { createAsaasProvider } from '@seta/payment-provider';
import { createExecutor, type Executor, loadCatalog } from '@seta/query-catalog';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminUrl, applySchema, seedData } from '../../../infra/erp-mock/seed.ts';
import { type App, buildApp } from '../src/app.ts';
import { createAuth } from '../src/auth.ts';
import { FILA_COBRANCA_EMITIR, FILA_COBRANCA_EVENTO, startBoss } from '../src/boss.ts';
import { createDb, type Db } from '../src/db/index.ts';
import {
  cobranca,
  cobrancaTitulo,
  conversa,
  eventoPsp,
  mensagem,
  outbox,
  pagamento,
  pspCliente,
} from '../src/db/schema.ts';
import { type Env, loadEnv } from '../src/env.ts';
import { createExecutorConciliado } from '../src/pagamentos/conciliacao.ts';
import { type EmitirDeps, processarEmissao } from '../src/pagamentos/emitir.ts';
import { registerCobrancaEventoWorker } from '../src/pagamentos/eventos.ts';
import { createPagamentosRepo } from '../src/pagamentos/repo.ts';
import { createDrizzleQueryEventSink } from '../src/query-event-sink.ts';
import { seedApp, USUARIOS_DEMO } from '../src/seed-app.ts';

/**
 * Spec 042 — o PSP deixa de ser simulado.
 *
 * Arquivo separado do `cobranca.integration.test.ts` porque ali o provider é
 * `createSimulatedPaymentProvider()` fixo no topo do módulo e injetado nos
 * workers de uma vez no `beforeAll`. Aqui o provider é o **adapter real do
 * Asaas** com `fetchFn` fake, e um dos casos precisa de um segundo app
 * apontando para a base URL de produção.
 *
 * O fake não é a fila posicional de `packages/payment-provider/test/asaas.test.ts`:
 * com sete chamadas em sequência uma fila fica ilegível e quebra a cada mudança
 * de ordem. É um roteador por método+path, com o estado que o sandbox tem.
 */

const WEBHOOK_TOKEN = 'token-de-teste-com-mais-de-32-caracteres-ok';
const SANDBOX = 'https://api-sandbox.asaas.com/v3';
const PRODUCAO = 'https://api.asaas.com/v3';
const CONTRATO = '10002';
const WA_ID = '5511999990002';

interface Chamada {
  readonly metodo: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

/** Roteador com o estado do sandbox: cria cliente e cobrança, devolve PIX, recebe em dinheiro. */
function asaasFake() {
  const chamadas: Chamada[] = [];
  const clientes = new Map<string, { id: string; externalReference: string }>();
  const pagamentos = new Map<string, Record<string, unknown>>();
  let seqCliente = 0;
  let seqPagamento = 0;
  /** Corpos de webhook que o Asaas dispararia fora de banda. */
  const webhooks: Record<string, unknown>[] = [];

  const fn = (async (entrada: string | URL | Request, init?: RequestInit) => {
    const url = String(entrada);
    const metodo = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    chamadas.push({
      metodo,
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body,
    });
    const caminho = url.slice(url.indexOf('/v3') + 3);
    const ok = (corpo: unknown, status = 200) => new Response(JSON.stringify(corpo), { status });

    if (metodo === 'GET' && caminho.startsWith('/customers?')) {
      const ref = new URL(url).searchParams.get('externalReference');
      const achado = ref ? clientes.get(ref) : undefined;
      return ok({ data: achado ? [achado] : [] });
    }
    if (metodo === 'POST' && caminho === '/customers') {
      seqCliente += 1;
      const criado = {
        id: `cus_00000${seqCliente}`,
        externalReference: String(body.externalReference),
      };
      clientes.set(criado.externalReference, criado);
      return ok(criado);
    }
    if (metodo === 'GET' && caminho.startsWith('/payments?')) {
      const ref = new URL(url).searchParams.get('externalReference');
      const achados = [...pagamentos.values()].filter((p) => p.externalReference === ref);
      return ok({ data: achados });
    }
    if (metodo === 'POST' && caminho === '/payments') {
      seqPagamento += 1;
      const id = `pay_00000${seqPagamento}`;
      const criado = {
        id,
        status: 'PENDING',
        value: body.value,
        dueDate: body.dueDate,
        invoiceUrl: `https://sandbox.asaas.com/i/${id}`,
        bankSlipUrl: null,
        externalReference: body.externalReference,
      };
      pagamentos.set(id, criado);
      return ok(criado);
    }
    const pixMatch = caminho.match(/^\/payments\/([^/]+)\/pixQrCode$/);
    if (metodo === 'GET' && pixMatch) {
      // formato cru do Asaas: não é ISO — a coluna pix_expira_em é `text` por isso
      return ok({ payload: '00020126820014br.gov.bcb.pix', expirationDate: '2027-09-18 23:59:59' });
    }
    const recebeMatch = caminho.match(/^\/payments\/([^/]+)\/receiveInCash$/);
    if (metodo === 'POST' && recebeMatch) {
      const id = String(recebeMatch[1]);
      const p = pagamentos.get(id);
      if (!p) return ok({ errors: [{ description: 'não existe' }] }, 400);
      p.status = 'RECEIVED_IN_CASH';
      // o sandbox dispara o webhook fora de banda; o teste o entrega depois
      webhooks.push({
        id: `evt_${id}&${webhooks.length + 1}`, // id do Asaas contém `&`
        event: 'PAYMENT_RECEIVED',
        payment: {
          id,
          status: 'RECEIVED',
          value: p.value,
          externalReference: p.externalReference,
          paymentDate: '2026-09-15',
        },
      });
      return ok(p);
    }
    return ok({ errors: [{ description: `rota não roteada: ${metodo} ${caminho}` }] }, 404);
  }) as typeof fetch;

  return {
    fn,
    chamadas,
    webhooks,
    chamadasDe: (metodo: string, trecho: string) =>
      chamadas.filter((c) => c.metodo === metodo && c.url.includes(trecho)),
    /** Zera o estado da conta entre testes — ids voltam a ser determinísticos. */
    reset() {
      chamadas.length = 0;
      webhooks.length = 0;
      clientes.clear();
      pagamentos.clear();
      seqCliente = 0;
      seqPagamento = 0;
    },
  };
}

let admin: pg.Pool;
let db: Db;
let closeDb: () => Promise<void>;
let boss: Awaited<ReturnType<typeof startBoss>>;
let app: App;
let auth: ReturnType<typeof createAuth>;
let env: Env;
let executor: Executor;
let connector: DbConnector;
let cookie: string;
let psp: ReturnType<typeof createAsaasProvider>;
let fake: ReturnType<typeof asaasFake>;
let deps: EmitirDeps;

const logger = createLogger({ level: 'silent', name: 'teste-042' });
const clientConfig = loadClientConfig(
  join(import.meta.dirname, '../../../configs/demo/client.yaml'),
);

async function aguardar(cond: () => Promise<boolean>, timeoutMs = 12_000): Promise<void> {
  const ate = Date.now() + timeoutMs;
  while (Date.now() < ate) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('condição não atingida no tempo');
}

const apiConsole = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });

const webhook = (body: unknown, token = WEBHOOK_TOKEN) =>
  app.inject({
    method: 'POST',
    url: '/webhooks/asaas',
    headers: { 'asaas-access-token': token },
    payload: body as Record<string, unknown>,
  });

/** Cria a cobrança direto no banco e roda a emissão — sem LLM, sem debounce, determinístico. */
async function emitirCobranca(tituloId: string, valorCentavos: number): Promise<string> {
  const [conv] = await db.select().from(conversa).where(eq(conversa.waId, WA_ID));
  if (!conv) throw new Error(`conversa de ${WA_ID} ausente — o beforeEach não a criou?`);
  const id = newTraceId();
  await db.insert(cobranca).values({
    id,
    conversaId: conv.id,
    contratoId: CONTRATO,
    referenciaExterna: `contrato:${CONTRATO}:titulos:${tituloId}`,
    status: 'emitindo',
    metodo: 'pix',
    valorCentavos,
    vencimentoPsp: '2026-09-18',
    psp: 'asaas',
  });
  await db.insert(cobrancaTitulo).values({
    cobrancaId: id,
    tituloId,
    origem: 'saldo',
    parcela: 7,
    totalParcelas: 100,
    valorCentavos,
    vencimento: '2026-06-27',
  });
  await processarEmissao(deps, { cobrancaId: id }, false);
  return id;
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

  env = loadEnv({
    DATABASE_URL:
      process.env.DATABASE_URL ?? 'postgres://app_owner:app_owner_dev@localhost:5432/app',
    ERP_DATABASE_URL:
      process.env.ERP_DATABASE_URL ?? 'postgres://erp_ro:erp_ro_dev@localhost:5432/erp_mock',
    LOG_LEVEL: 'silent',
    DEV_SIMULATOR: 'true',
    CONTATOS_PATH: join(import.meta.dirname, '../../../configs/demo/contatos.yaml'),
    EMBEDDING_DIM: '8',
    ASAAS_WEBHOOK_TOKEN: WEBHOOK_TOKEN,
  } as NodeJS.ProcessEnv);

  const criado = createDb(env.DATABASE_URL);
  db = criado.db;
  closeDb = criado.close;
  await migrate(db, { migrationsFolder: join(import.meta.dirname, '../drizzle') });
  await seedApp(db, env);

  connector = createPgConnector({ url: env.ERP_DATABASE_URL, poolMax: 3 });
  const catalog = await loadCatalog(join(import.meta.dirname, '../../../catalog'));
  const repo = createPagamentosRepo(db);
  executor = createExecutorConciliado(
    createExecutor({ catalog, connector, sink: createDrizzleQueryEventSink(db) }),
    repo,
  );

  boss = await startBoss(env.DATABASE_URL, logger);

  fake = asaasFake();
  psp = createAsaasProvider({ baseUrl: SANDBOX, apiKey: 'chave-sandbox', fetchFn: fake.fn });
  deps = { db, boss, repo, psp, logger, nomeCliente: clientConfig.nome };

  const gatewayFake = {
    async send() {
      return { waMessageId: 'wamid.x' };
    },
    async sendTemplate() {
      return { waMessageId: 'wamid.tpl' };
    },
  };
  await registerCobrancaEventoWorker({ db, boss, repo, gateway: gatewayFake, env, logger });

  auth = createAuth(db, { secret: env.BETTER_AUTH_SECRET, baseURL: env.BETTER_AUTH_URL });
  app = buildApp({
    env,
    clientConfig,
    wa: { db, boss },
    console: { auth, executor },
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
  await boss.deleteQueuedJobs(FILA_COBRANCA_EVENTO);
  await boss.deleteQueuedJobs(FILA_COBRANCA_EMITIR);
  await db.delete(pagamento);
  await db.delete(cobrancaTitulo);
  await db.delete(cobranca);
  await db.delete(eventoPsp);
  await db.delete(pspCliente);
  // a conversa normalmente nasce na primeira mensagem; aqui o fluxo conversacional
  // não roda (o teste é do PSP, não do agente), então ela é criada à mão.
  await db
    .insert(conversa)
    .values({ id: newTraceId(), waId: WA_ID })
    .onConflictDoNothing({ target: conversa.waId });
  fake.reset();
});

afterAll(async () => {
  // a suíte é serial e compartilha o banco: deixar `cobranca` para trás trava o
  // `delete from conversa` de outros arquivos pela FK (06-como-desenvolver.md).
  await db?.delete(pagamento);
  await db?.delete(cobrancaTitulo);
  await db?.delete(cobranca);
  await db?.delete(eventoPsp);
  await db?.delete(pspCliente);
  await db?.delete(outbox);
  await db?.delete(mensagem);
  // e a conversa que este arquivo criou: deixá-la para trás a colocava no topo
  // de `GET /api/console/conversas` e quebrava a contagem de não-lidas da #45.
  await db?.delete(conversa).where(eq(conversa.waId, WA_ID));
  await app?.close();
  await boss?.stop();
  await connector?.close();
  await closeDb?.();
  await admin?.end();
});

describe('spec 042 — Asaas real no sandbox', () => {
  it('ciclo real: emitir → PIX → receiveInCash → webhook → baixa → conciliação', async () => {
    expect(psp.nome).toBe('asaas');
    expect(psp.ambiente).toBe('sandbox');

    const id = await emitirCobranca('138', 114_100);
    const [c] = await db.select().from(cobranca).where(eq(cobranca.id, id));
    expect(c?.status).toBe('emitida');
    expect(c?.pspCobrancaId).toBe('pay_000001');
    expect(c?.urlFatura).toBe('https://sandbox.asaas.com/i/pay_000001');
    expect(c?.pixCopiaCola).toBe('00020126820014br.gov.bcb.pix');
    expect(c?.pixExpiraEm).toBe('2027-09-18 23:59:59');

    // autenticação do Asaas é header `access_token`, nunca Bearer
    const criacao = fake.chamadasDe('POST', '/payments')[0];
    expect(criacao?.headers.access_token).toBe('chave-sandbox');
    expect(criacao?.headers.authorization).toBeUndefined();
    expect(criacao?.body).toMatchObject({
      externalReference: 'contrato:10002:titulos:138',
      billingType: 'PIX',
      value: 1141,
    });

    // o console já mostra o PSP real, e o aviso de simulado sai por consequência
    const lista = await apiConsole('GET', '/api/console/cobrancas');
    expect(lista.json()).toMatchObject({ psp: 'asaas', ambiente: 'sandbox', simuladorAtivo: true });

    // receiveInCash: no sandbox o Asaas dispara o webhook, o server NÃO injeta evento
    const sim = await apiConsole('POST', `/api/console/cobrancas/${id}/simular-pagamento`);
    expect(sim.statusCode).toBe(202);
    expect(sim.json()).toEqual({ ok: true, psp: 'asaas' });
    expect(fake.chamadasDe('POST', '/receiveInCash')).toHaveLength(1);
    expect(await db.select().from(eventoPsp)).toHaveLength(0);

    // o webhook que o sandbox dispararia, entregue assinado
    const evento = fake.webhooks[0];
    expect((await webhook(evento)).statusCode).toBe(200);
    await aguardar(async () => {
      const [x] = await db.select().from(cobranca).where(eq(cobranca.id, id));
      return x?.status === 'paga';
    });
    const titulos = await db.select().from(cobrancaTitulo);
    const pagos = await db.select().from(pagamento);
    expect(pagos).toHaveLength(titulos.length);
    expect(pagos[0]).toMatchObject({ tituloId: '138', status: 'confirmado', metodo: 'pix' });

    // conciliação: o título pago some de titulos_atraso
    const r = await executor.run(
      'financeiro.titulos_atraso',
      {},
      { traceId: newTraceId(), clienteId: CONTRATO },
    );
    expect(r.rows.some((linha) => String(linha.titulo_id) === '138')).toBe(false);
  }, 60_000);

  it('emitir a mesma referência duas vezes reaproveita — sem duplicata no Asaas', async () => {
    const id = await emitirCobranca('139', 114_100);
    expect(fake.chamadasDe('POST', '/payments')).toHaveLength(1);
    const [antes] = await db.select().from(cobranca).where(eq(cobranca.id, id));
    const pspIdOriginal = antes?.pspCobrancaId;
    expect(pspIdOriginal).toBeTruthy();

    // a emissão roda de novo (retry do pg-boss, reprocesso manual): não pode criar outra
    await db.update(cobranca).set({ status: 'emitindo' }).where(eq(cobranca.id, id));
    await processarEmissao(deps, { cobrancaId: id }, false);

    const [c] = await db.select().from(cobranca).where(eq(cobranca.id, id));
    expect(c?.status).toBe('emitida');
    expect(c?.pspCobrancaId).toBe(pspIdOriginal);
    expect(c?.tentativas).toBe(2);
    expect(fake.chamadasDe('POST', '/payments')).toHaveLength(1);
    // e o cliente do PSP também é reaproveitado
    expect(fake.chamadasDe('POST', '/customers')).toHaveLength(1);
  }, 60_000);

  it('webhook: token errado não tem efeito; reentrega não processa duas vezes', async () => {
    const id = await emitirCobranca('140', 114_100);
    await apiConsole('POST', `/api/console/cobrancas/${id}/simular-pagamento`);
    const evento = fake.webhooks[0];
    expect(evento).toBeDefined();

    expect((await webhook(evento, 'token-errado')).statusCode).toBe(401);
    expect(await db.select().from(eventoPsp)).toHaveLength(0);

    expect((await webhook(evento)).json()).toEqual({ recebido: true, duplicado: false });
    await aguardar(async () => {
      const [x] = await db.select().from(cobranca).where(eq(cobranca.id, id));
      return x?.status === 'paga';
    });
    const antes = await db.select().from(pagamento);

    expect((await webhook(evento)).json()).toEqual({ recebido: true, duplicado: true });
    expect(await db.select().from(eventoPsp)).toHaveLength(1);
    expect(await db.select().from(pagamento)).toHaveLength(antes.length);
  }, 60_000);

  it('simular-pagamento não existe em produção, mesmo com DEV_SIMULATOR=true', async () => {
    const id = await emitirCobranca('141', 114_100);

    const fakeProd = asaasFake();
    const pspProd = createAsaasProvider({
      baseUrl: PRODUCAO,
      apiKey: 'chave-producao',
      fetchFn: fakeProd.fn,
    });
    expect(pspProd.ambiente).toBe('producao');
    const appProd = buildApp({
      env, // DEV_SIMULATOR continua true — quem barra é o ambiente
      clientConfig,
      wa: { db, boss },
      console: { auth, executor },
      pagamentos: { repo: createPagamentosRepo(db), psp: pspProd },
    });
    try {
      const r = await appProd.inject({
        method: 'POST',
        url: `/api/console/cobrancas/${id}/simular-pagamento`,
        headers: { cookie },
      });
      expect(r.statusCode).toBe(404);
      // a guarda vem antes de qualquer leitura ou chamada ao PSP
      expect(fakeProd.chamadas).toHaveLength(0);

      const lista = await appProd.inject({
        method: 'GET',
        url: '/api/console/cobrancas',
        headers: { cookie },
      });
      expect(lista.json()).toMatchObject({ ambiente: 'producao', simuladorAtivo: false });
    } finally {
      await appProd.close();
    }
  }, 60_000);
});
