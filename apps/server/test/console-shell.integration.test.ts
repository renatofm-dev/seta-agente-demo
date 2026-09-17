import { join } from 'node:path';
import { loadClientConfig } from '@seta/client-config';
import { createPgConnector, type DbConnector } from '@seta/erp-connector';
import { createLogger, newTraceId } from '@seta/observability';
import { createSimulatedPaymentProvider } from '@seta/payment-provider';
import { createExecutor, type Executor, loadCatalog } from '@seta/query-catalog';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminUrl, applySchema, seedData } from '../../../infra/erp-mock/seed.ts';
import { type App, buildApp } from '../src/app.ts';
import { createAuth } from '../src/auth.ts';
import { startBoss } from '../src/boss.ts';
import { createDb, type Db } from '../src/db/index.ts';
import {
  cobranca,
  cobrancaTitulo,
  conversa,
  conversaLeitura,
  disparo,
  disparoDestinatario,
  eventoTicket,
  fluxoCobranca,
  fluxoSdr,
  lead,
  mensagem,
  modeloMensagem,
  outbox,
  pagamento,
  propostaSdr,
  sinalAprendizado,
  ticket,
  traceTurno,
  turno,
} from '../src/db/schema.ts';
import { type Env, loadEnv } from '../src/env.ts';
import { createPagamentosRepo } from '../src/pagamentos/repo.ts';
import { createDrizzleQueryEventSink } from '../src/query-event-sink.ts';
import { seedApp, USUARIOS_DEMO } from '../src/seed-app.ts';

/**
 * Rotas que o console redesenhado (Console SETA.dc.html, 2026-09) consome além
 * das já cobertas pelos testes de #45/013/014: instalação, badges da barra,
 * contagens da lista, contexto financeiro/origem, leads (leitura), feedback do
 * atendente e equipe. Exige Postgres dev.
 */

const WA_VINCULADO = '5511999990001'; // contrato 10001 no contatos.yaml
const WA_LEAD = '5541999990212';

const logger = createLogger({ name: 'teste-console-shell', level: 'silent' });
let env: Env;
let db: Db;
let closeDb: () => Promise<void>;
let boss: Awaited<ReturnType<typeof startBoss>>;
let app: App;
let admin: pg.Pool;
let connector: DbConnector;
let executor: Executor;
let cookie = '';
let userId = '';

const clientConfig = loadClientConfig(
  join(import.meta.dirname, '../../../configs/demo/client.yaml'),
);
const catalog = loadCatalog(join(import.meta.dirname, '../../../catalog'));

async function api(method: 'GET' | 'POST', url: string, payload?: unknown, c = cookie) {
  return app.inject({
    method,
    url,
    headers: { cookie: c },
    ...(payload !== undefined ? { payload } : {}),
  });
}

async function login(email: string, password: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    payload: { email, password },
  });
  expect(res.statusCode).toBe(200);
  const setCookie = res.headers['set-cookie'];
  return (Array.isArray(setCookie) ? setCookie : [setCookie ?? ''])
    .map((c) => c.split(';')[0])
    .join('; ');
}

/** Ordem respeita as FKs (mensagem → turno/conversa; pagamento/título → cobrança). */
async function limpar() {
  await db.delete(sinalAprendizado);
  await db.delete(eventoTicket);
  await db.delete(ticket);
  await db.delete(propostaSdr);
  await db.delete(fluxoSdr);
  await db.delete(lead);
  await db.delete(pagamento);
  await db.delete(cobrancaTitulo);
  await db.delete(fluxoCobranca);
  await db.delete(cobranca);
  await db.delete(traceTurno);
  await db.delete(outbox);
  await db.delete(mensagem);
  await db.delete(turno);
  await db.delete(conversaLeitura);
  await db.delete(conversa);
}

async function novaConversa(waId: string): Promise<string> {
  const id = newTraceId();
  await db.insert(conversa).values({ id, waId, janelaExpiraEm: new Date(Date.now() + 3_600_000) });
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
  } as NodeJS.ProcessEnv);
  const criado = createDb(env.DATABASE_URL);
  db = criado.db;
  closeDb = criado.close;
  await migrate(db, { migrationsFolder: join(import.meta.dirname, '../drizzle') });
  await seedApp(db, env);

  connector = createPgConnector({ url: env.ERP_DATABASE_URL, poolMax: 3 });
  executor = createExecutor({ catalog, connector, sink: createDrizzleQueryEventSink(db) });
  const auth = createAuth(db, { secret: env.BETTER_AUTH_SECRET, baseURL: env.BETTER_AUTH_URL });
  boss = await startBoss(env.DATABASE_URL, logger);
  app = buildApp({
    env,
    clientConfig,
    wa: { db, boss },
    console: { auth, executor },
    pagamentos: { repo: createPagamentosRepo(db), psp: createSimulatedPaymentProvider() },
  });

  const atendente = USUARIOS_DEMO[0];
  cookie = await login(atendente?.email ?? '', atendente?.password ?? '');
  userId = (await api('GET', '/api/console/me')).json().userId;
}, 60_000);

beforeEach(async () => {
  await limpar();
});

afterAll(async () => {
  await limpar();
  await app?.close();
  await boss?.stop({ graceful: false });
  await connector?.close();
  await closeDb?.();
  await admin?.end();
});

describe('console redesenhado — instalação e barra', () => {
  it('/api/instalacao é público (só o nome); /api/console/instalacao exige sessão', async () => {
    const publico = await app.inject({ method: 'GET', url: '/api/instalacao' });
    expect(publico.statusCode).toBe(200);
    expect(publico.json()).toEqual({ nome: clientConfig.nome });

    const semSessao = await app.inject({ method: 'GET', url: '/api/console/instalacao' });
    expect(semSessao.statusCode).toBe(401);

    const res = await api('GET', '/api/console/instalacao');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      nome: clientConfig.nome,
      modulos: { pagamentos: true, sdr: true },
      alcadas: {
        tetoAprovacaoCentavos: env.PAGAMENTO_TETO_SEM_HITL_CENTAVOS,
        descontoMaxBps: env.SDR_DESCONTO_MAX_BPS,
      },
      canal: { gateway: 'log-only', metaConfigurada: false, simulador: true },
      psp: { nome: 'simulado' },
    });
    // nunca segredos
    expect(JSON.stringify(res.json())).not.toMatch(/secret|token|api_key/i);
  });

  it('/api/console/resumo conta fila, cobranças e propostas que esperam gente', async () => {
    const convId = await novaConversa(WA_VINCULADO);
    await db.insert(ticket).values({
      id: newTraceId(),
      conversaId: convId,
      status: 'aguardando_humano',
      escaladoEm: new Date(),
      motivoEscalonamento: 'negociacao_preco',
    });
    await db.insert(cobranca).values({
      id: newTraceId(),
      conversaId: convId,
      contratoId: '10001',
      referenciaExterna: 'contrato:10001:titulos:t1',
      status: 'aguardando_aprovacao',
      metodo: 'pix',
      valorCentavos: 980_000,
      vencimentoPsp: '2026-09-15',
      psp: 'simulado',
    });
    const leadConv = await novaConversa(WA_LEAD);
    const leadId = newTraceId();
    await db
      .insert(lead)
      .values({ id: leadId, waId: WA_LEAD, conversaId: leadConv, status: 'proposta' });
    await db.insert(propostaSdr).values({
      id: newTraceId(),
      leadId,
      conversaId: leadConv,
      cotaId: 'C501',
      cotaCodigo: 'C501-133',
      referencia: `lead:${WA_LEAD}:cota:C501`,
      valorTabelaCentavos: 20_825_000,
      valorMinimoCentavos: 20_200_250,
      valorOfertadoCentavos: 20_200_250,
      descontoBps: 300,
      valorPedidoCentavos: 19_500_000,
      status: 'aguardando_aprovacao',
    });

    const res = await api('GET', '/api/console/resumo');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      aguardandoHumano: 1,
      cobrancasAguardandoAprovacao: 1,
      leadsAguardandoAprovacao: 1,
      // 038: conta as que esperam aprovação E as criadas sem confirmação
      reservasAguardandoAprovacao: 0,
    });
  });

  it('/api/console/equipe lista as pessoas com papel, sem senha', async () => {
    const res = await api('GET', '/api/console/equipe');
    expect(res.statusCode).toBe(200);
    const pessoas = res.json().pessoas as { email: string; role: string; nome: string }[];
    expect(pessoas.map((p) => [p.email, p.role])).toEqual(
      expect.arrayContaining(USUARIOS_DEMO.map((u) => [u.email, u.role])),
    );
    expect(JSON.stringify(pessoas)).not.toMatch(/password|senha/i);
  });
});

describe('console redesenhado — atendimento', () => {
  it('/api/console/conversas traz contagens por chip e o filtro "agente" pega conversa sem ticket', async () => {
    const doBot = await novaConversa(WA_VINCULADO); // sem ticket = com o agente
    const escalada = await novaConversa(WA_LEAD);
    await db.insert(ticket).values({
      id: newTraceId(),
      conversaId: escalada,
      status: 'aguardando_humano',
      escaladoEm: new Date(),
    });

    const todas = await api('GET', '/api/console/conversas');
    expect(todas.statusCode).toBe(200);
    expect(todas.json().contagens).toEqual({
      todas: 2,
      aguardando: 1,
      minhas: 0,
      agente: 1,
      resolvidas: 0,
    });

    const agente = await api('GET', '/api/console/conversas?filtro=agente');
    const ids = (agente.json().conversas as { conversaId: string }[]).map((c) => c.conversaId);
    expect(ids).toEqual([doBot]);
  });

  it('/api/console/conversa/:id traz o resumo financeiro do ERP e a campanha de origem', async () => {
    const convId = await novaConversa(WA_VINCULADO);
    // a campanha mais recente que alcançou o número é a origem da conversa
    const modeloId = newTraceId();
    const disparoId = newTraceId();
    await db.insert(modeloMensagem).values({
      id: modeloId,
      nome: `origem_${disparoId.slice(-6)}`,
      corpo: 'Olá {{1}}',
      statusMeta: 'aprovado',
      criadoPor: userId,
    });
    await db.insert(disparo).values({ id: disparoId, modeloId, criadoPor: userId });
    await db.insert(disparoDestinatario).values({
      id: newTraceId(),
      disparoId,
      waId: WA_VINCULADO,
      status: 'lido',
    });
    try {
      const res = await api('GET', `/api/console/conversa/${convId}`);
      expect(res.statusCode).toBe(200);
      const corpo = res.json();
      expect(corpo.origem).toMatchObject({
        disparoId,
        modelo: `origem_${disparoId.slice(-6)}`,
        statusDestinatario: 'lido',
      });
      expect(corpo.financeiro).toMatchObject({
        vencidas: expect.any(Number),
        saldoVencidoCentavos: expect.any(Number),
        maiorAtrasoDias: expect.any(Number),
      });
      expect(corpo.perfilErp).not.toBeNull();
    } finally {
      await db.delete(disparoDestinatario).where(eq(disparoDestinatario.disparoId, disparoId));
      await db.delete(disparo).where(eq(disparo.id, disparoId));
      await db.delete(modeloMensagem).where(eq(modeloMensagem.id, modeloId));
    }
  });

  it('/api/console/cobrancas?conversaId= filtra por conversa', async () => {
    const a = await novaConversa(WA_VINCULADO);
    const b = await novaConversa(WA_LEAD);
    for (const [conv, ref] of [
      [a, 'contrato:10001:titulos:a'],
      [b, 'contrato:10002:titulos:b'],
    ] as const) {
      await db.insert(cobranca).values({
        id: newTraceId(),
        conversaId: conv,
        contratoId: '10001',
        referenciaExterna: ref,
        status: 'emitida',
        metodo: 'boleto',
        valorCentavos: 125_000,
        vencimentoPsp: '2026-09-15',
        psp: 'simulado',
      });
    }
    const res = await api('GET', `/api/console/cobrancas?conversaId=${a}`);
    expect(res.statusCode).toBe(200);
    const linhas = res.json().cobrancas as { conversaId: string }[];
    expect(linhas).toHaveLength(1);
    expect(linhas[0]?.conversaId).toBe(a);
  });
});

describe('console redesenhado — leads (leitura da 015)', () => {
  it('lista o lead com perfil e última proposta; o detalhe traz o histórico', async () => {
    const convId = await novaConversa(WA_LEAD);
    const leadId = newTraceId();
    await db.insert(lead).values({
      id: leadId,
      waId: WA_LEAD,
      conversaId: convId,
      status: 'proposta',
      perfil: { pessoas: 4, periodos: 2, contato: null },
    });
    const base = {
      leadId,
      conversaId: convId,
      cotaId: 'C501',
      cotaCodigo: 'C501-133',
      referencia: `lead:${WA_LEAD}:cota:C501`,
      valorTabelaCentavos: 20_825_000,
      valorMinimoCentavos: 20_200_250,
    };
    await db.insert(propostaSdr).values({
      id: newTraceId(),
      ...base,
      valorOfertadoCentavos: 20_825_000,
      descontoBps: 0,
      status: 'recusada',
      criadoEm: new Date(Date.now() - 60_000),
    });
    await db.insert(propostaSdr).values({
      id: newTraceId(),
      ...base,
      valorOfertadoCentavos: 20_200_250,
      descontoBps: 300,
      valorPedidoCentavos: 19_500_000,
      status: 'aguardando_aprovacao',
    });

    const lista = await api('GET', '/api/console/leads');
    expect(lista.statusCode).toBe(200);
    expect(lista.json().leads).toHaveLength(1);
    expect(lista.json().leads[0]).toMatchObject({
      id: leadId,
      waId: WA_LEAD,
      status: 'proposta',
      perfil: { pessoas: 4, periodos: 2, contato: null },
      proposta: {
        status: 'aguardando_aprovacao',
        cotaCodigo: 'C501-133',
        valorPedidoCentavos: 19_500_000,
        descontoBps: 300,
      },
    });

    const detalhe = await api('GET', `/api/console/leads/${leadId}`);
    expect(detalhe.statusCode).toBe(200);
    const propostas = detalhe.json().propostas as { status: string }[];
    expect(propostas.map((p) => p.status)).toEqual(['recusada', 'aguardando_aprovacao']);
    expect(detalhe.json().fluxo).toBeNull();

    const inexistente = await api('GET', `/api/console/leads/${newTraceId()}`);
    expect(inexistente.statusCode).toBe(404);
  });
});

describe('console redesenhado — feedback do atendente sobre um turno', () => {
  async function turnoComTrace(convId: string) {
    const turnoId = newTraceId();
    await db
      .insert(turno)
      .values({ id: turnoId, conversaId: convId, textoAgregado: 'consegue desconto?' });
    const traceId = newTraceId();
    await db.insert(traceTurno).values({
      id: traceId,
      turnoId,
      conversaId: convId,
      traceId: 'tr_teste',
      contexto: { skills: [] },
      eventos: [{ tipo: 'escalado' }],
      resposta: 'Entendo. Já passei para um atendente.',
      escalado: true,
      fallback: false,
      tokensEntrada: 10,
      tokensSaida: 5,
      latenciaMs: 120,
    });
    return traceId;
  }

  it('cria o sinal feedback_atendente com o par texto→resposta; repetir substitui; GET traces devolve', async () => {
    const convId = await novaConversa(WA_VINCULADO);
    const ticketId = newTraceId();
    await db
      .insert(ticket)
      .values({ id: ticketId, conversaId: convId, status: 'aguardando_humano' });
    const traceId = await turnoComTrace(convId);

    const ruim = await api('POST', `/api/console/traces/${traceId}/feedback`, {
      avaliacao: 'ruim',
      motivos: ['devia_ter_escalado'],
      sugestao: 'Explicar que quem avalia condições é a equipe.',
    });
    expect(ruim.statusCode).toBe(200);

    const sinais = await db
      .select()
      .from(sinalAprendizado)
      .where(eq(sinalAprendizado.tipo, 'feedback_atendente'));
    expect(sinais).toHaveLength(1);
    expect(sinais[0]).toMatchObject({
      ticketId,
      conversaId: convId,
      payload: {
        traceTurnoId: traceId,
        avaliacao: 'ruim',
        motivo: 'devia_ter_escalado',
        textoUsuario: 'consegue desconto?',
        respostaHumano: 'Explicar que quem avalia condições é a equipe.',
        atendenteId: userId,
      },
    });

    // muda de ideia: 👍 substitui o sinal em vez de duplicar
    const bom = await api('POST', `/api/console/traces/${traceId}/feedback`, { avaliacao: 'bom' });
    expect(bom.statusCode).toBe(200);
    const depois = await db
      .select()
      .from(sinalAprendizado)
      .where(eq(sinalAprendizado.tipo, 'feedback_atendente'));
    expect(depois).toHaveLength(1);
    expect(depois[0]).toMatchObject({ payload: expect.objectContaining({ avaliacao: 'bom' }) });

    const traces = await api('GET', `/api/console/ticket/${ticketId}/traces`);
    expect(traces.statusCode).toBe(200);
    expect(traces.json().traces[0].feedback).toEqual({
      avaliacao: 'bom',
      motivos: [],
      sugestao: null,
    });

    const invalido = await api('POST', `/api/console/traces/${traceId}/feedback`, {
      avaliacao: 'mais_ou_menos',
    });
    expect(invalido.statusCode).toBe(400);
    const naoExiste = await api('POST', `/api/console/traces/${newTraceId()}/feedback`, {
      avaliacao: 'bom',
    });
    expect(naoExiste.statusCode).toBe(404);
  });
});
