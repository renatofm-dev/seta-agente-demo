import { join } from 'node:path';
import { createFakeProvider } from '@seta/ai-provider/testing';
import { loadClientConfig } from '@seta/client-config';
import { createPgConnector, type DbConnector } from '@seta/erp-connector';
import { createLogger, createNoopObsEmitter, newTraceId } from '@seta/observability';
import { createExecutor, type Executor, loadCatalog } from '@seta/query-catalog';
import {
  type OutboundTemplate,
  signBody,
  type TemplateApi,
  type TemplateDef,
  type TemplateStatus,
} from '@seta/wa-meta';
import { count, eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminUrl, applySchema, seedData } from '../../../infra/erp-mock/seed.ts';
import { type App, buildApp } from '../src/app.ts';
import { createAuth } from '../src/auth.ts';
import { FILA_DEBOUNCE, FILA_DISPARO, startBoss } from '../src/boss.ts';
import { createDb, type Db } from '../src/db/index.ts';
import {
  conversa,
  conversaLeitura,
  disparo,
  disparoDestinatario,
  eventoQuery,
  eventoTicket,
  mensagem,
  modeloMensagem,
  outbox,
  sinalAprendizado,
  supressao,
  ticket,
  traceTurno,
  turno,
} from '../src/db/schema.ts';
import { type Env, loadEnv } from '../src/env.ts';
import { createDrizzleQueryEventSink } from '../src/query-event-sink.ts';
import { createPgVectorStore } from '../src/rag/pgvector-store.ts';
import { seedApp, USUARIOS_DEMO } from '../src/seed-app.ts';
import { registerDebounceWorker } from '../src/wa/debounce.ts';
import { processarDisparo, registerDisparoWorker, renderizarCorpo } from '../src/wa/disparo.ts';
import { suprimir } from '../src/wa/supressao.ts';
import { ticketPermiteBot } from '../src/wa/tickets.ts';
import { createAgentTurnoHandler } from '../src/wa/turno-handler.ts';

/**
 * Critérios da spec 013: modelo criado DA PLATAFORMA (registrado na Meta via
 * TemplateApi) com sync de aprovação; disparo só com modelo aprovado; envio
 * ignora a janela de 24h; falha por destinatário não derruba o disparo;
 * webhook de status atualiza o destinatário; resposta do cliente ao disparo
 * cai no fluxo normal de turno. Exige Postgres dev.
 */

const DEBOUNCE_MS = 400;
const logger = createLogger({ name: 'teste-disparos', level: 'silent' });

let env: Env;
let db: Db;
let closeDb: () => Promise<void>;
let boss: Awaited<ReturnType<typeof startBoss>>;
let app: App;
let appSemMeta: App;
let admin: pg.Pool;
let connector: DbConnector;
let executor: Executor;
let fake = createFakeProvider();
let cookie = '';

const clientConfig = loadClientConfig(
  join(import.meta.dirname, '../../../configs/demo/client.yaml'),
);
const catalog = loadCatalog(join(import.meta.dirname, '../../../catalog'));

/** TemplateApi fake: grava as criações e devolve o que o teste configurar. */
const templateApiFake = {
  criados: [] as TemplateDef[],
  statusPorNome: new Map<string, { status: TemplateStatus; motivo?: string }>(),
  api: {
    async criar(def: TemplateDef) {
      templateApiFake.criados.push(def);
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

/** Gateway fake: templates enviados ficam registrados; waIds em `falhar` explodem. */
const gatewayFake = {
  templates: [] as OutboundTemplate[],
  falhar: new Set<string>(),
  seq: 0,
  gateway: {
    async send() {
      gatewayFake.seq += 1;
      return { waMessageId: `wamid.txt-${gatewayFake.seq}` };
    },
    async sendTemplate(msg: OutboundTemplate) {
      if (gatewayFake.falhar.has(msg.to)) throw new Error('Graph API 400: numero bloqueado');
      gatewayFake.templates.push(msg);
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

/** Cria um modelo e o marca como aprovado (via sync fake). */
async function modeloAprovado(nome: string, corpo: string) {
  const criar = await apiConsole('POST', '/api/console/modelos', { nome, corpo });
  expect(criar.statusCode).toBe(201);
  templateApiFake.statusPorNome.set(nome, { status: 'aprovado' });
  expect((await apiConsole('POST', '/api/console/modelos/sincronizar')).statusCode).toBe(200);
  return criar.json().modelo as { id: string };
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
  await registerDisparoWorker({ db, boss, gateway: gatewayFake.gateway, logger });

  app = buildApp({
    env,
    clientConfig,
    wa: { db, boss },
    console: { auth, executor, templateApi: templateApiFake.api },
  });
  appSemMeta = buildApp({ env, clientConfig, wa: { db, boss }, console: { auth, executor } });

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
  templateApiFake.criados = [];
  templateApiFake.statusPorNome.clear();
  gatewayFake.templates = [];
  gatewayFake.falhar.clear();
  gatewayFake.seq = 0;
  await boss.deleteQueuedJobs(FILA_DEBOUNCE);
  await boss.deleteQueuedJobs(FILA_DISPARO);
  for (let tentativa = 0; ; tentativa++) {
    try {
      await db.delete(disparoDestinatario);
      await db.delete(disparo);
      await db.delete(supressao); // 044: supressão de um teste não vaza para o outro
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
  /**
   * 044: a supressão sai daqui. Ela é a única tabela deste arquivo que muda o
   * COMPORTAMENTO de outros arquivos — um número suprimido faz o disparo do
   * teste de relatórios recusar o envio, e o funil dele quebra longe da causa.
   * Foi o que aconteceu na primeira versão.
   */
  await db.delete(supressao);
  await app?.close();
  await appSemMeta?.close();
  await boss?.stop({ graceful: false });
  await connector?.close();
  await closeDb?.();
  await admin?.end();
});

describe('spec 013 — modelos criados da plataforma', () => {
  it('criar registra na Meta e persiste como pendente; duplicado → 409; sync aprova/rejeita', async () => {
    const criar = await apiConsole('POST', '/api/console/modelos', {
      nome: 'aviso_parcela',
      corpo: 'Olá {{1}}, sua parcela vence {{2}}.',
      rodape: 'Mirante da Serra Resort',
    });
    expect(criar.statusCode).toBe(201);
    expect(criar.json().modelo.statusMeta).toBe('pendente');
    expect(templateApiFake.criados[0]?.nome).toBe('aviso_parcela'); // foi PRA META

    expect(
      (await apiConsole('POST', '/api/console/modelos', { nome: 'aviso_parcela', corpo: 'x y z' }))
        .statusCode,
    ).toBe(409);

    // a Meta aprova um e rejeita outro — o sync reflete os dois
    await apiConsole('POST', '/api/console/modelos', { nome: 'promo_verao', corpo: 'Promoção!' });
    templateApiFake.statusPorNome.set('aviso_parcela', { status: 'aprovado' });
    templateApiFake.statusPorNome.set('promo_verao', {
      status: 'rejeitado',
      motivo: 'INVALID_FORMAT',
    });
    const sync = await apiConsole('POST', '/api/console/modelos/sincronizar');
    expect(sync.statusCode).toBe(200);
    expect(sync.json().atualizados).toBe(2);
    const modelos = sync.json().modelos as { nome: string; statusMeta: string }[];
    expect(modelos.find((m) => m.nome === 'aviso_parcela')?.statusMeta).toBe('aprovado');
    expect(modelos.find((m) => m.nome === 'promo_verao')?.statusMeta).toBe('rejeitado');
  });

  it('sem WA_WABA_ID configurado, criar modelo responde 503 explicado', async () => {
    const res = await appSemMeta.inject({
      method: 'POST',
      url: '/api/console/modelos',
      headers: { cookie },
      payload: { nome: 'qualquer_um', corpo: 'oi' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().erro).toContain('WA_WABA_ID');
  });
});

describe('spec 013 — disparos para a carteira', () => {
  it('modelo não aprovado → 400; variáveis erradas → 400; fora da carteira → 400', async () => {
    const criar = await apiConsole('POST', '/api/console/modelos', {
      nome: 'nao_aprovado',
      corpo: 'Oi {{1}}!',
    });
    const modeloId = criar.json().modelo.id;
    const pendente = await apiConsole('POST', '/api/console/disparos', {
      modeloId,
      variaveis: ['x'],
      waIds: ['5511999990001'],
    });
    expect(pendente.statusCode).toBe(400);
    expect(pendente.json().erro).toMatch(/não está aprovado/);

    const aprovado = await modeloAprovado('com_variavel', 'Oi {{1}}, tudo bem?');
    const semVariavel = await apiConsole('POST', '/api/console/disparos', {
      modeloId: aprovado.id,
      variaveis: [],
      waIds: ['5511999990001'],
    });
    expect(semVariavel.statusCode).toBe(400);
    expect(semVariavel.json().erro).toMatch(/variável/);

    const foraDaCarteira = await apiConsole('POST', '/api/console/disparos', {
      modeloId: aprovado.id,
      variaveis: ['cotista'],
      waIds: ['5511999990001', '5599999999999'],
    });
    expect(foraDaCarteira.statusCode).toBe(400);
    expect(foraDaCarteira.json().erro).toContain('5599999999999');
  });

  it('dispara IGNORANDO a janela de 24h, grava a thread e falha por destinatário não derruba', async () => {
    const modelo = await modeloAprovado('aviso_geral', 'Olá {{1}}! Novidades do resort.');
    // uma conversa JÁ existe com janela FECHADA — texto livre seria proibido
    const [convVelha] = await db
      .insert(conversa)
      .values({
        id: '01990a5d-ac96-774b-bcce-b302099a9001',
        waId: '5511999990001',
        janelaExpiraEm: new Date(Date.now() - 3600_000),
      })
      .returning();
    gatewayFake.falhar.add('5511999990002'); // este número explode no gateway

    const res = await apiConsole('POST', '/api/console/disparos', {
      modeloId: modelo.id,
      variaveis: ['cotista'],
      waIds: ['5511999990001', '5511999990002', '5511999990003'],
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().destinatarios).toBe(3);

    await aguardar(async () => (await db.select().from(disparo))[0]?.status === 'concluido');
    const destinatarios = await db.select().from(disparoDestinatario);
    const porWa = new Map(destinatarios.map((d) => [d.waId, d]));
    // janela fechada NÃO impediu o template
    expect(porWa.get('5511999990001')?.status).toBe('enviado');
    expect(porWa.get('5511999990003')?.status).toBe('enviado');
    // falha marcou SÓ o destinatário problemático
    expect(porWa.get('5511999990002')?.status).toBe('falha');
    expect(porWa.get('5511999990002')?.erro).toContain('numero bloqueado');
    expect(gatewayFake.templates.map((t) => t.to).sort()).toEqual([
      '5511999990001',
      '5511999990003',
    ]);
    expect(gatewayFake.templates[0]?.variaveis).toEqual(['cotista']);

    // a thread mostra o disparo: mensagem `campanha` com o corpo renderizado
    const msgs = await db.select().from(mensagem).where(eq(mensagem.autor, 'campanha'));
    expect(msgs).toHaveLength(2);
    expect(msgs[0]?.texto).toBe(renderizarCorpo('Olá {{1}}! Novidades do resort.', ['cotista']));
    // na conversa existente a mensagem entrou na MESMA conversa (sem duplicar)
    const daVelha = msgs.find((m) => m.conversaId === convVelha?.id);
    expect(daVelha).toBeDefined();
    // e para o wa_id sem conversa, uma nova nasceu SEM abrir janela
    const [convNova] = await db.select().from(conversa).where(eq(conversa.waId, '5511999990003'));
    expect(convNova?.janelaExpiraEm).toBeNull();

    // resumo por status na listagem
    const lista = await apiConsole('GET', '/api/console/disparos');
    expect(lista.json().disparos[0]).toMatchObject({ total: 3, enviados: 2, falhas: 1 });
  }, 30_000);

  it('044: quem está na supressão não recebe, e aparece como recusado', async () => {
    const modelo = await modeloAprovado('aviso_optout', 'Olá {{1}}! Aviso do resort.');
    await suprimir(db, '5511999990002', 'pedido_do_contato', 'pediu para sair');

    const res = await apiConsole('POST', '/api/console/disparos', {
      modeloId: modelo.id,
      variaveis: ['cotista'],
      waIds: ['5511999990001', '5511999990002', '5511999990003'],
    });

    expect(res.statusCode).toBe(202);
    /**
     * A resposta diz quem NÃO vai receber. Sumir em silêncio seria pior que
     * enviar: quem criou a campanha iria procurar no funil por que faltou um.
     */
    expect(res.json()).toMatchObject({ destinatarios: 2, recusados: ['5511999990002'] });

    await aguardar(async () => (await db.select().from(disparo))[0]?.status === 'concluido');
    const porWa = new Map((await db.select().from(disparoDestinatario)).map((d) => [d.waId, d]));
    expect(porWa.get('5511999990002')?.status).toBe('recusado');
    expect(porWa.get('5511999990002')?.erro).toContain('supressão');
    // e o template NÃO foi para ele
    expect(gatewayFake.templates.map((t) => t.to)).not.toContain('5511999990002');

    // a listagem conta recusado separado de falha — opt-out não é erro de envio
    const lista = await apiConsole('GET', '/api/console/disparos');
    expect(lista.json().disparos[0]).toMatchObject({
      total: 3,
      enviados: 2,
      recusados: 1,
      falhas: 0,
    });
  }, 30_000);

  it('044: supressão que entra DEPOIS da criação ainda é respeitada no envio', async () => {
    const modelo = await modeloAprovado('aviso_optout_tardio', 'Olá {{1}}!');
    const res = await apiConsole('POST', '/api/console/disparos', {
      modeloId: modelo.id,
      variaveis: ['cotista'],
      waIds: ['5511999990001', '5511999990003'],
    });
    expect(res.json().destinatarios).toBe(2);

    /**
     * O pedido de saída chega entre a criação e o envio — que é justamente
     * quando isso acontece de verdade, porque as primeiras mensagens do disparo
     * já saíram. Por isso a conferência existe nos DOIS lugares.
     */
    await suprimir(db, '5511999990003', 'pedido_do_contato', 'pediu no meio do disparo');
    const disparoId = res.json().disparoId as string;
    await processarDisparo({ db, gateway: gatewayFake.gateway, logger }, disparoId);

    const porWa = new Map(
      (
        await db
          .select()
          .from(disparoDestinatario)
          .where(eq(disparoDestinatario.disparoId, disparoId))
      ).map((d) => [d.waId, d]),
    );
    expect(porWa.get('5511999990001')?.status).toBe('enviado');
    expect(porWa.get('5511999990003')?.status).toBe('recusado');
  }, 30_000);

  it('webhook de status atualiza o destinatário; resposta do cliente vira turno normal', async () => {
    const modelo = await modeloAprovado('reengaja', 'Voltamos a falar!');
    await apiConsole('POST', '/api/console/disparos', {
      modeloId: modelo.id,
      variaveis: [],
      waIds: ['5511999990001'],
    });
    await aguardar(async () => (await db.select().from(disparo))[0]?.status === 'concluido');
    const [dest] = await db.select().from(disparoDestinatario);
    expect(dest?.status).toBe('enviado');

    // status "read" chega pelo webhook assinado — destinatário E mensagem refletem
    const corpo = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [{ value: { statuses: [{ id: dest?.waMessageId ?? '', status: 'read' }] } }],
        },
      ],
    });
    const webhook = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signBody(corpo, env.WA_APP_SECRET),
      },
      payload: corpo,
    });
    expect(webhook.statusCode).toBe(200);
    const [depois] = await db.select().from(disparoDestinatario);
    expect(depois?.status).toBe('lido');
    const [msg] = await db.select().from(mensagem).where(eq(mensagem.autor, 'campanha'));
    expect(msg?.status).toBe('lida');

    // o cliente responde ao disparo → fluxo normal: turno nasce e o bot atende
    fake = createFakeProvider().respondeTexto('outro').respondeTexto('Que bom te ver de volta!');
    const inbound = await app.inject({
      method: 'POST',
      url: '/dev/inbound',
      headers: { cookie },
      payload: { waId: '5511999990001', text: 'oi, recebi a mensagem de vocês' },
    });
    expect(inbound.statusCode).toBe(202);
    await aguardar(
      async () => ((await db.select({ n: count() }).from(traceTurno))[0]?.n ?? 0) === 1,
    );
    expect((await db.select({ n: count() }).from(turno))[0]?.n).toBe(1);
  }, 30_000);

  it('044: "SAIR" suprime, confirma e NÃO chama o modelo', async () => {
    /**
     * O provider fake é criado SEM respostas: se o turno chegasse ao modelo, o
     * teste falharia na fila vazia. É assim que se prova que o opt-out roda
     * antes do classificador — e que continua funcionando com o LLM fora do ar.
     */
    fake = createFakeProvider();

    const inbound = await app.inject({
      method: 'POST',
      url: '/dev/inbound',
      headers: { cookie },
      payload: { waId: '5511999990001', text: 'SAIR' },
    });
    expect(inbound.statusCode).toBe(202);

    await aguardar(async () => (await db.select().from(supressao)).length === 1);
    const [linha] = await db.select().from(supressao);
    expect(linha).toMatchObject({ waId: '5511999990001', origem: 'pedido_do_contato' });
    expect(linha?.detalhe).toBe('SAIR');

    // uma confirmação, e só ela
    const saidas = await db.select().from(outbox);
    expect(saidas).toHaveLength(1);
    expect(saidas[0]?.texto).toContain('não vai mais receber mensagens');
    expect(fake.requests).toHaveLength(0);

    // e um disparo criado depois já nasce recusando este número
    const modelo = await modeloAprovado('depois_do_optout', 'Olá!');
    const res = await apiConsole('POST', '/api/console/disparos', {
      modeloId: modelo.id,
      variaveis: [],
      waIds: ['5511999990001'],
    });
    expect(res.json()).toMatchObject({ destinatarios: 0, recusados: ['5511999990001'] });
  }, 30_000);
});

/**
 * 044 — variável por destinatário.
 *
 * O disparo da 013 tem UM conjunto de variáveis para todo mundo, o que serve
 * para "sua parcela vence amanhã" e não serve para cobrança: link e código PIX
 * mudam a cada pessoa. Estes testes fixam as duas formas e a fronteira entre
 * elas — inclusive que a 013 continua igual, que é o critério 6 da spec.
 */
describe('spec 044 — variáveis por destinatário', () => {
  it('cada destinatário recebe o SEU valor, no template e na thread', async () => {
    const modelo = await modeloAprovado('cobranca_um', 'Olá {{1}}, sua parcela é {{2}}.');

    const res = await apiConsole('POST', '/api/console/disparos', {
      modeloId: modelo.id,
      destinatarios: [
        { waId: '5511999990001', variaveis: ['Ana', 'R$ 1.200,00'] },
        { waId: '5511999990003', variaveis: ['Bruno', 'R$ 350,00'] },
      ],
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().destinatarios).toBe(2);

    await aguardar(async () => (await db.select().from(disparo))[0]?.status === 'concluido');

    const porWa = new Map(gatewayFake.templates.map((t) => [t.to, t.variaveis]));
    expect(porWa.get('5511999990001')).toEqual(['Ana', 'R$ 1.200,00']);
    expect(porWa.get('5511999990003')).toEqual(['Bruno', 'R$ 350,00']);

    // a thread de cada um mostra o texto DELE — o defeito a evitar é gravar o
    // texto do primeiro na conversa de todos
    const msgs = await db.select().from(mensagem).where(eq(mensagem.autor, 'campanha'));
    const textos = msgs.map((m) => m.texto).sort();
    expect(textos).toEqual([
      'Olá Ana, sua parcela é R$ 1.200,00.',
      'Olá Bruno, sua parcela é R$ 350,00.',
    ]);
  }, 30_000);

  it('critério 6: disparo da 013 (waIds + variáveis globais) não muda', async () => {
    const modelo = await modeloAprovado('aviso_013', 'Olá {{1}}! Aviso.');
    const res = await apiConsole('POST', '/api/console/disparos', {
      modeloId: modelo.id,
      variaveis: ['cotista'],
      waIds: ['5511999990001', '5511999990003'],
    });
    expect(res.statusCode).toBe(202);
    await aguardar(async () => (await db.select().from(disparo))[0]?.status === 'concluido');

    // ninguém ganhou variável própria: a coluna fica nula e o worker lê a global
    const dests = await db.select().from(disparoDestinatario);
    expect(dests.every((d) => d.variaveis === null)).toBe(true);
    expect(gatewayFake.templates.every((t) => t.variaveis?.[0] === 'cotista')).toBe(true);
  }, 30_000);

  it('as duas formas juntas → 400, e o global junto com destinatarios → 400', async () => {
    const modelo = await modeloAprovado('cobranca_dois', 'Olá {{1}}!');

    const ambas = await apiConsole('POST', '/api/console/disparos', {
      modeloId: modelo.id,
      waIds: ['5511999990001'],
      destinatarios: [{ waId: '5511999990003', variaveis: ['Bruno'] }],
    });
    expect(ambas.statusCode).toBe(400);

    const nenhuma = await apiConsole('POST', '/api/console/disparos', { modeloId: modelo.id });
    expect(nenhuma.statusCode).toBe(400);

    const comGlobal = await apiConsole('POST', '/api/console/disparos', {
      modeloId: modelo.id,
      variaveis: ['cotista'],
      destinatarios: [{ waId: '5511999990003', variaveis: ['Bruno'] }],
    });
    expect(comGlobal.statusCode).toBe(400);
  });

  it('contagem errada e repetido dizem DE QUEM — não só que houve erro', async () => {
    const modelo = await modeloAprovado('cobranca_tres', 'Olá {{1}}, parcela {{2}}.');

    const faltando = await apiConsole('POST', '/api/console/disparos', {
      modeloId: modelo.id,
      destinatarios: [
        { waId: '5511999990001', variaveis: ['Ana', 'R$ 10'] },
        { waId: '5511999990003', variaveis: ['Bruno'] },
      ],
    });
    expect(faltando.statusCode).toBe(400);
    expect(faltando.json().erro).toContain('5511999990003');
    expect(faltando.json().erro).not.toContain('5511999990001');

    const repetido = await apiConsole('POST', '/api/console/disparos', {
      modeloId: modelo.id,
      destinatarios: [
        { waId: '5511999990001', variaveis: ['Ana', 'R$ 10'] },
        { waId: '5511999990001', variaveis: ['Ana', 'R$ 99'] },
      ],
    });
    expect(repetido.statusCode).toBe(400);
    expect(repetido.json().erro).toContain('5511999990001');
  });

  it('a listagem do console avisa que as variáveis são por destinatário', async () => {
    const modelo = await modeloAprovado('cobranca_quatro', 'Olá {{1}}!');
    await apiConsole('POST', '/api/console/disparos', {
      modeloId: modelo.id,
      destinatarios: [{ waId: '5511999990001', variaveis: ['Ana'] }],
    });
    await aguardar(async () => (await db.select().from(disparo))[0]?.status === 'concluido');

    const lista = await apiConsole('GET', '/api/console/disparos');
    expect(lista.json().disparos[0]).toMatchObject({
      variaveis: [],
      variaveis_por_destinatario: true,
    });
  }, 30_000);
});

/**
 * 044 — ritmo de envio: pausa entre destinatários e disjuntor por falhas
 * consecutivas.
 *
 * O laço era sequencial sem pausa, sem backoff e sem parada. Para aviso da 013
 * passava; para cobrança proativa o preço de errar não é um disparo perdido, é
 * a qualidade do número na Meta.
 *
 * Os testes chamam `processarDisparo` DIRETO, sem passar pela fila: o worker
 * registrado no `beforeAll` usa o ritmo padrão, e disputar o mesmo job com ele
 * daria um teste que passa ou falha pela ordem do agendador.
 */
describe('spec 044 — ritmo de envio', () => {
  async function disparoCru(nome: string, waIds: string[]): Promise<string> {
    const modelo = await modeloAprovado(nome, 'Olá {{1}}!');
    const disparoId = newTraceId();
    await db.insert(disparo).values({
      id: disparoId,
      modeloId: modelo.id,
      variaveis: ['cotista'],
      criadoPor: 'teste',
    });
    await db
      .insert(disparoDestinatario)
      .values(waIds.map((waId) => ({ id: newTraceId(), disparoId, waId, contatoNome: waId })));
    return disparoId;
  }

  it('para por falhas consecutivas e deixa o resto PENDENTE para reprocesso', async () => {
    gatewayFake.falhar.add('5511999990001');
    gatewayFake.falhar.add('5511999990002');
    const id = await disparoCru('ritmo_disjuntor', [
      '5511999990001',
      '5511999990002',
      '5511999990003',
    ]);

    await processarDisparo(
      {
        db,
        boss,
        gateway: gatewayFake.gateway,
        logger,
        ritmo: { pausaMs: 0, pararEmFalhasSeguidas: 2 },
      },
      id,
    );

    const dests = await db
      .select()
      .from(disparoDestinatario)
      .where(eq(disparoDestinatario.disparoId, id));
    const porWa = new Map(dests.map((d) => [d.waId, d.status]));
    expect(porWa.get('5511999990001')).toBe('falha');
    expect(porWa.get('5511999990002')).toBe('falha');
    // o terceiro NUNCA foi tentado — e continua pendente, não "falha"
    expect(porWa.get('5511999990003')).toBe('pendente');
    expect(gatewayFake.templates.map((t) => t.to)).not.toContain('5511999990003');

    // e o disparo NÃO foi concluído: concluir marcaria como feito o que não saiu
    const [d] = await db.select().from(disparo).where(eq(disparo.id, id));
    expect(d?.status).toBe('enviando');
  }, 30_000);

  it('sucesso zera o contador: falhas alternadas não abrem o disjuntor', async () => {
    gatewayFake.falhar.add('5511999990002');
    const id = await disparoCru('ritmo_alternado', [
      '5511999990001',
      '5511999990002',
      '5511999990003',
    ]);

    await processarDisparo(
      {
        db,
        boss,
        gateway: gatewayFake.gateway,
        logger,
        ritmo: { pausaMs: 0, pararEmFalhasSeguidas: 2 },
      },
      id,
    );

    const dests = await db
      .select()
      .from(disparoDestinatario)
      .where(eq(disparoDestinatario.disparoId, id));
    const porWa = new Map(dests.map((d) => [d.waId, d.status]));
    expect(porWa.get('5511999990001')).toBe('enviado');
    expect(porWa.get('5511999990002')).toBe('falha');
    // chegou ao fim: a falha do meio não parou o disparo
    expect(porWa.get('5511999990003')).toBe('enviado');
    const [d] = await db.select().from(disparo).where(eq(disparo.id, id));
    expect(d?.status).toBe('concluido');
  }, 30_000);

  it('a pausa espaça os envios, e não acontece antes do primeiro', async () => {
    const id = await disparoCru('ritmo_pausa', ['5511999990001', '5511999990003']);
    const inicio = Date.now();
    await processarDisparo(
      {
        db,
        boss,
        gateway: gatewayFake.gateway,
        logger,
        ritmo: { pausaMs: 400, pararEmFalhasSeguidas: 3 },
      },
      id,
    );
    const gasto = Date.now() - inicio;
    // 2 destinatários ⇒ UMA pausa (nunca antes do primeiro, nunca depois do último)
    expect(gasto).toBeGreaterThanOrEqual(400);
    expect(gasto).toBeLessThan(1_200);
    expect(gatewayFake.templates).toHaveLength(2);
  }, 30_000);
});
