import { join } from 'node:path';
import { createFakeProvider } from '@seta/ai-provider/testing';
import { loadClientConfig } from '@seta/client-config';
import { createTseErpApi, type ErpWriter } from '@seta/erp-api-tse';
import { createPgConnector, type DbConnector } from '@seta/erp-connector';
import { createLogger, createNoopObsEmitter, newTraceId } from '@seta/observability';
import { createSimulatedPaymentProvider } from '@seta/payment-provider';
import { createExecutor, type Executor, loadCatalog } from '@seta/query-catalog';
import { asc, desc, eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  adminUrl,
  applySchema,
  CONTRATO_DEMO_EM_DIA,
  seedData,
} from '../../../infra/erp-mock/seed.ts';
import { buildTseSimApp } from '../../tse-sim/src/app.ts';
import { criarBanco } from '../../tse-sim/src/db.ts';
import { loadEnv as loadEnvSim } from '../../tse-sim/src/env.ts';
import { type App, buildApp } from '../src/app.ts';
import { createAuth } from '../src/auth.ts';
import { FILA_ERP_RESERVA, startBoss } from '../src/boss.ts';
import { createDb, type Db } from '../src/db/index.ts';
import {
  contato,
  conversa,
  conversaLeitura,
  erpEscrita,
  eventoTicket,
  fluxoReserva,
  mensagem,
  outbox,
  reserva,
  sinalAprendizado,
  ticket,
  traceTurno,
  turno,
} from '../src/db/schema.ts';
import { type Env, loadEnv } from '../src/env.ts';
import { createPagamentosRepo } from '../src/pagamentos/repo.ts';
import { createDrizzleQueryEventSink } from '../src/query-event-sink.ts';
import { createPgVectorStore } from '../src/rag/pgvector-store.ts';
import { chaveReserva } from '../src/reserva/chave.ts';
import {
  continuarFluxo,
  iniciarFluxo,
  type ReservaFluxoDeps,
  type ResultadoFluxoReserva,
} from '../src/reserva/fluxo.ts';
import { createReservaRepo } from '../src/reserva/repo.ts';
import { processarReserva } from '../src/reserva/worker.ts';
import { seedApp, USUARIOS_DEMO } from '../src/seed-app.ts';
import { registerDebounceWorker } from '../src/wa/debounce.ts';
import { ticketPermiteBot } from '../src/wa/tickets.ts';
import { createAgentTurnoHandler } from '../src/wa/turno-handler.ts';

/**
 * Spec 038 — a reserva sai da conversa e chega ao ERP.
 *
 * O fluxo fala com o simulador da 035 **de verdade**: o `fetchFn` entra no
 * Fastify do `apps/tse-sim` por `inject`, sem porta e sem rede — o mesmo
 * caminho do homelab. O efeito é conferido onde importa: em
 * `tse_sim.utilizacaocontrato`, incluindo QUEM pediu.
 *
 * Exige o Postgres dev de pé (docker compose -f infra/compose.dev.yml up -d).
 */

const CONTRATO = String(CONTRATO_DEMO_EM_DIA);
const WA_ID = '5511999990038';
/** Maio: tarifa PADRÃO em todos os tipos — nada bloqueado. */
const LIVRE = { checkIn: '2027-05-10', checkOut: '2027-05-13' };
/** Janeiro é ALTA, e LUXO em alta está bloqueado no seed. */
const BLOQUEADO = { checkIn: '2028-01-10', checkOut: '2028-01-13' };
const logger = createLogger({ level: 'silent', name: 'teste-038' });
/** LLM fake: neste arquivo só o CLASSIFICADOR de intenção passa por ele. */
let fake = createFakeProvider();
/** Debounce curto — o teste de roteamento espera o turno de verdade. */
const DEBOUNCE_MS = 300;
const clientConfig = loadClientConfig(
  join(import.meta.dirname, '../../../configs/demo/client.yaml'),
);

let admin: pg.Pool;
let db: Db;
let closeDb: () => Promise<void>;
let boss: Awaited<ReturnType<typeof startBoss>>;
let env: Env;
let connector: DbConnector;
let executor: Executor;
let simApp: Awaited<ReturnType<typeof buildTseSimApp>>;
let simDb: ReturnType<typeof criarBanco>;
let writer: ErpWriter;
let deps: ReservaFluxoDeps;
let app: App;
let cookie: string;
let conversaId: string;
let quedas = 0;
let engolirResposta = false;

/** `fetch` que entra direto no Fastify do simulador. */
const fetchNoSimulador: typeof fetch = async (entrada, init) => {
  const url = new URL(String(entrada));
  if (quedas > 0) {
    quedas -= 1;
    throw new TypeError('fetch failed');
  }
  const r = await simApp.inject({
    method: (init?.method ?? 'GET') as 'GET' | 'POST' | 'PUT',
    url: `${url.pathname}${url.search}`,
    headers: init?.headers as Record<string, string>,
    ...(init?.body ? { payload: String(init.body) } : {}),
  });
  if (engolirResposta && url.pathname.includes('CriarUtilizacaoContrato')) {
    throw new TypeError('fetch failed'); // a escrita chegou; a resposta não voltou
  }
  return new Response(r.body, {
    status: r.statusCode,
    headers: { 'content-type': r.headers['content-type'] as string },
  });
};

const ctxTurno = (texto: string) => ({
  conversaId,
  turnoId: newTraceId(),
  session: { traceId: newTraceId(), clienteId: CONTRATO },
  textoUsuario: texto,
});

/** Conduz a conversa até a confirmação, devolvendo a última transição. */
async function ate(
  passos: readonly string[],
  over: Partial<ReservaFluxoDeps> = {},
): Promise<ResultadoFluxoReserva> {
  const d = { ...deps, ...over };
  let r = await iniciarFluxo(d, ctxTurno('quero reservar'));
  for (const texto of passos) {
    const ativo = await d.repo.fluxoAtivo(conversaId);
    if (!ativo) break;
    r = await continuarFluxo(d, ativo, ctxTurno(texto));
  }
  return r;
}

const CAMINHO_FELIZ = [
  `de ${LIVRE.checkIn} a ${LIVRE.checkOut}`,
  '1', // hotel
  '1', // tipo de unidade
  '1 adulto',
  'só eu',
  'sim',
];

async function utilizacoesNoErp(): Promise<
  { idutilizacao: number; status: string; operador: string | null }[]
> {
  const { rows } = await admin.query<{
    idutilizacao: number;
    status: string;
    operador: string | null;
  }>(
    `SELECT u.idutilizacao, u.status, o.nome AS operador
       FROM tse_sim.utilizacaocontrato u
       LEFT JOIN tse_sim.operador o ON o.idoperador = u.idoperador
      WHERE u.idcontrato = $1 ORDER BY u.idutilizacao`,
    [CONTRATO_DEMO_EM_DIA],
  );
  return rows;
}

const reservaDaConversa = async () =>
  (await db.select().from(reserva).where(eq(reserva.conversaId, conversaId)))[0];

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
    CONTATOS_PATH: join(import.meta.dirname, '../../../configs/demo/contatos.yaml'),
    EMBEDDING_DIM: '8',
    // /dev/inbound é o caminho do teste de roteamento por intenção; sem o
    // debounce curto o turno só roda 10 s depois (default de WA_DEBOUNCE_MS)
    DEV_SIMULATOR: 'true',
    WA_DEBOUNCE_MS: String(DEBOUNCE_MS),
  } as NodeJS.ProcessEnv);

  const criado = createDb(env.DATABASE_URL);
  db = criado.db;
  closeDb = criado.close;
  await migrate(db, { migrationsFolder: join(import.meta.dirname, '../drizzle') });
  await seedApp(db, env);

  simDb = criarBanco(
    process.env.TSE_SIM_DATABASE_URL ?? 'postgres://tse_sim:tse_sim_dev@localhost:5432/erp_mock',
  );
  simApp = buildTseSimApp({
    env: loadEnvSim({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      // o operador DEDICADO do agente existe no seed (`tse_sim.operador`); o
      // login precisa bater, porque é ele que vira IdOperadorRespSolicitacao
      TSE_SIM_USERS: 'integracao:integracao:1,AGENTE.SETA:agente:1',
    }),
    db: simDb,
  });
  await simApp.ready();

  // credencial DEDICADA: o TSE grava quem pediu, e o teste confere isso
  writer = createTseErpApi({
    baseUrl: 'http://tse-sim:3010',
    username: 'AGENTE.SETA',
    password: 'agente',
    fetchFn: fetchNoSimulador,
    esperar: async () => {},
  });

  boss = await startBoss(env.DATABASE_URL, logger);
  connector = createPgConnector({ url: env.ERP_DATABASE_URL, poolMax: 3 });
  const catalog = await loadCatalog(join(import.meta.dirname, '../../../catalog'));
  executor = createExecutor({ catalog, connector, sink: createDrizzleQueryEventSink(db) });

  deps = {
    db,
    boss,
    executor,
    repo: createReservaRepo(db),
    pagamentos: createPagamentosRepo(db),
    writer,
    provider: null,
    env: {
      RESERVA_TETO_TAXA_SEM_HITL_CENTAVOS: env.RESERVA_TETO_TAXA_SEM_HITL_CENTAVOS,
      RESERVA_FLUXO_EXPIRA_MIN: env.RESERVA_FLUXO_EXPIRA_MIN,
    },
    logger,
  };

  /**
   * O turno COMPLETO (debounce → classificador → roteamento), que os testes
   * acima não exercitam porque chamam `iniciarFluxo` direto. É aqui que a
   * regressão do classificador aparecia: sem a categoria `reservar`, a frase
   * do cotista era classificada como `comprar_cota` e o turno escalava.
   */
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
      // reservaDeps só existe com `pagamentos` presente (as duas vivem na raia
      // do cotista); o PSP simulado basta — nenhum teste daqui cobra nada.
      pagamentos: { repo: createPagamentosRepo(db), psp: createSimulatedPaymentProvider(), env },
      reserva: {
        repo: deps.repo,
        writer,
        env: deps.env,
      },
    }),
    logger,
  });

  const auth = createAuth(db, { secret: env.BETTER_AUTH_SECRET, baseURL: env.BETTER_AUTH_URL });
  app = buildApp({ env, clientConfig, wa: { db, boss }, console: { auth, executor } });
  const atendente = USUARIOS_DEMO[0];
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    payload: { email: atendente?.email, password: atendente?.password },
  });
  const setCookie = login.headers['set-cookie'];
  cookie = (Array.isArray(setCookie) ? setCookie : [setCookie ?? ''])
    .map((c) => c.split(';')[0])
    .join('; ');
}, 180_000);

beforeEach(async () => {
  quedas = 0;
  engolirResposta = false;
  await boss.deleteQueuedJobs(FILA_ERP_RESERVA);
  await db.delete(fluxoReserva);
  await db.delete(erpEscrita);
  await db.delete(reserva);
  await db.delete(eventoTicket);
  await db.delete(sinalAprendizado);
  await db.delete(ticket);
  await db.delete(outbox);
  await admin.query('DELETE FROM tse_sim.hospede');
  await admin.query('DELETE FROM tse_sim.utilizacaocontrato');
  const [conv] = await db
    .insert(conversa)
    .values({ id: newTraceId(), waId: WA_ID, clienteErpId: CONTRATO })
    .onConflictDoNothing({ target: conversa.waId })
    .returning({ id: conversa.id });
  const [existente] = await db.select().from(conversa).where(eq(conversa.waId, WA_ID));
  conversaId = (conv?.id ?? existente?.id) as string;
  // o CPF que o cotista já deu à plataforma (014) é o do hóspede principal
  await db
    .insert(contato)
    .values({
      id: newTraceId(),
      waId: WA_ID,
      nome: 'BRUNO FERREIRA',
      clienteErpId: CONTRATO,
      documento: '53022628277',
      verificadoEm: new Date(),
    })
    .onConflictDoUpdate({
      target: contato.waId,
      set: { clienteErpId: CONTRATO, documento: '53022628277', nome: 'BRUNO FERREIRA' },
    });
});

afterAll(async () => {
  await db?.delete(fluxoReserva);
  await db?.delete(erpEscrita);
  await db?.delete(reserva);
  await db?.delete(eventoTicket);
  await db?.delete(sinalAprendizado);
  await db?.delete(ticket);
  await db?.delete(outbox);
  await db?.delete(traceTurno);
  await db?.delete(mensagem); // FK mensagem.turno_id → turno: mensagem primeiro
  await db?.delete(turno);
  await db?.delete(conversaLeitura);
  await db?.delete(contato).where(eq(contato.waId, WA_ID));
  await db?.delete(conversa).where(eq(conversa.waId, WA_ID));
  await app?.close();
  await boss?.stop({ graceful: false });
  await simApp?.close();
  await simDb?.fechar();
  await connector?.close();
  await closeDb?.();
  if (admin) await seedData(admin);
  await admin?.end();
}, 180_000);

describe('a conversa vira uma reserva', () => {
  it('pergunta o que falta, simula com dado do ERP e confirma', async () => {
    const r = await ate(CAMINHO_FELIZ);

    const linha = await reservaDaConversa();
    expect(linha?.status).toBe('criando');
    expect(linha?.checkIn).toBe(LIVRE.checkIn);
    // pontos e taxa vieram da SIMULAÇÃO do ERP, não de conta nossa
    expect(linha?.custoPontos).toBeGreaterThan(0);
    expect(linha?.taxaCentavos).toBeGreaterThan(0);
    expect(r.reservaId).toBe(linha?.id);
  });

  it('o hóspede principal é o titular, com o CPF que a plataforma já tinha', async () => {
    await ate(CAMINHO_FELIZ);

    const linha = await reservaDaConversa();
    const hospedes = linha?.hospedes as { nome: string; cpf: string; principal: boolean }[];
    expect(hospedes[0]).toMatchObject({ cpf: '53022628277', principal: true });
  });

  it('a mensagem da simulação cita pontos e taxa em reais', async () => {
    const d = { ...deps };
    await iniciarFluxo(d, ctxTurno('quero reservar'));
    for (const texto of CAMINHO_FELIZ.slice(0, 4)) {
      const ativo = await d.repo.fluxoAtivo(conversaId);
      const r = await continuarFluxo(d, ativo as NonNullable<typeof ativo>, ctxTurno(texto));
      if (texto === '1 adulto') {
        expect(r.mensagens.join('\n')).toMatch(/Pontos: [\d.]+/);
        expect(r.mensagens.join('\n')).toMatch(/R\$ [\d.,]+/);
      }
    }
  });
});

describe('a reserva chega ao ERP', () => {
  it('cria e confirma a utilização, com o OPERADOR que pediu', async () => {
    const r = await ate(CAMINHO_FELIZ);
    expect(await utilizacoesNoErp()).toHaveLength(0);

    expect(await processarReserva(deps, r.reservaId as string)).toBe('confirmada');

    const [u] = await utilizacoesNoErp();
    expect(u?.status).toBe('CONFIRMADA');
    // o rastro que separa robô de humano
    expect(u?.operador).toBe('Agente SETA');
    const linha = await reservaDaConversa();
    expect(linha?.status).toBe('confirmada');
    expect(linha?.erpUtilizacaoId).toBe(String(u?.idutilizacao));
  });

  it('o cotista é avisado pelo outbox', async () => {
    const r = await ate(CAMINHO_FELIZ);
    await processarReserva(deps, r.reservaId as string);

    const saidas = await db.select().from(outbox).where(eq(outbox.conversaId, conversaId));
    expect(saidas.some((o) => o.texto?.includes('Reserva confirmada'))).toBe(true);
  });

  it('processar duas vezes NÃO cria segunda utilização', async () => {
    const r = await ate(CAMINHO_FELIZ);

    expect(await processarReserva(deps, r.reservaId as string)).toBe('confirmada');
    expect(await processarReserva(deps, r.reservaId as string)).toBe('ja-resolvida');

    expect(await utilizacoesNoErp()).toHaveLength(1);
  });

  /**
   * O caso que justifica o read-back por chave natural: o POST CHEGA ao TSE, a
   * utilização é criada, e a resposta se perde. Repetir cegamente criaria uma
   * segunda reserva e queimaria os pontos do cotista duas vezes.
   */
  it('resposta perdida na criação: o read-back ADOTA a utilização que já existe', async () => {
    const r = await ate(CAMINHO_FELIZ);

    engolirResposta = true;
    await expect(processarReserva(deps, r.reservaId as string)).rejects.toThrow(/sem resposta/);
    expect(await utilizacoesNoErp()).toHaveLength(1); // chegou uma vez
    engolirResposta = false;

    expect(await processarReserva(deps, r.reservaId as string)).toBe('adotada');
    expect(await utilizacoesNoErp()).toHaveLength(1); // e continua sendo uma
    expect((await utilizacoesNoErp())[0]?.status).toBe('CONFIRMADA');
  });

  it('ERP fora do ar deixa a escrita pendente e o erro sobe para o pg-boss', async () => {
    const r = await ate(CAMINHO_FELIZ);

    quedas = 99;
    await expect(processarReserva(deps, r.reservaId as string)).rejects.toThrow();
    quedas = 0;

    const [escrita] = await db
      .select()
      .from(erpEscrita)
      .where(eq(erpEscrita.chave, chaveReserva(r.reservaId as string)));
    expect(escrita?.estado).toBe('pendente');
    expect(await utilizacoesNoErp()).toHaveLength(0);
  });
});

describe('quando o ERP diz não', () => {
  it('período bloqueado encerra citando a data, e nada é criado', async () => {
    const r = await ate([
      `de ${BLOQUEADO.checkIn} a ${BLOQUEADO.checkOut}`,
      '1',
      '3', // LUXO
      '2 adultos',
    ]);

    expect(r.mensagens.join('\n')).toContain('10/01');
    const ativo = await deps.repo.fluxoAtivo(conversaId);
    expect(ativo).toBeNull(); // encerrado
    expect(await reservaDaConversa()).toBeUndefined();
    expect(await utilizacoesNoErp()).toHaveLength(0);
  });

  it('pontos insuficientes encerram com o saldo do contrato', async () => {
    // consome o saldo com uma utilização grande direto no ERP
    await admin.query(
      `INSERT INTO tse_sim.utilizacaocontrato
         (idcontrato, idedificiohotel, idtipounidadehoteleira, datacheckin, datacheckout,
          qtdpagantes, qtdpontosdebitados, status)
       VALUES ($1, 1, 1, '2027-02-01', '2027-02-05', 2, 999999, 'CONFIRMADA')`,
      [CONTRATO_DEMO_EM_DIA],
    );

    const r = await ate([`de ${LIVRE.checkIn} a ${LIVRE.checkOut}`, '1', '1', '1 adulto']);

    expect(r.mensagens.join('\n')).toMatch(/pontos/i);
    expect(await reservaDaConversa()).toBeUndefined();
  });
});

describe('taxa acima do teto: um humano decide', () => {
  const tetoBaixo = (): ReservaFluxoDeps => ({
    ...deps,
    env: { ...deps.env, RESERVA_TETO_TAXA_SEM_HITL_CENTAVOS: 100 },
  });

  it('fica aguardando aprovação, e NADA é escrito no ERP', async () => {
    const r = await ate(CAMINHO_FELIZ, tetoBaixo());

    const linha = await reservaDaConversa();
    expect(linha?.status).toBe('aguardando_aprovacao');
    expect(r.escalado).toBe(true);
    // sem linha em erp_escrita, o worker não tem o que fazer
    const escritas = await db.select().from(erpEscrita);
    expect(escritas).toHaveLength(0);
    expect(await utilizacoesNoErp()).toHaveLength(0);
  });

  it('o atendente aprova no console e aí sim a reserva vai ao ERP', async () => {
    await ate(CAMINHO_FELIZ, tetoBaixo());
    const linha = await reservaDaConversa();

    const aprovar = await app.inject({
      method: 'POST',
      url: `/api/console/reservas/${linha?.id}/aprovar`,
      headers: { cookie },
    });
    expect(aprovar.statusCode).toBe(202);

    // segundo clique não reprocessa
    const repetido = await app.inject({
      method: 'POST',
      url: `/api/console/reservas/${linha?.id}/aprovar`,
      headers: { cookie },
    });
    expect(repetido.statusCode).toBe(409);

    expect(await processarReserva(deps, linha?.id as string)).toBe('confirmada');
    expect(await utilizacoesNoErp()).toHaveLength(1);
  });

  it('recusada, o cotista é avisado e nada vai ao ERP', async () => {
    await ate(CAMINHO_FELIZ, tetoBaixo());
    const linha = await reservaDaConversa();

    const recusar = await app.inject({
      method: 'POST',
      url: `/api/console/reservas/${linha?.id}/recusar`,
      headers: { cookie },
      payload: { motivo: 'período em manutenção' },
    });
    expect(recusar.statusCode).toBe(200);

    expect((await reservaDaConversa())?.status).toBe('recusada');
    const saidas = await db.select().from(outbox).where(eq(outbox.conversaId, conversaId));
    expect(saidas.some((o) => o.texto?.includes('não pôde ser confirmada'))).toBe(true);
    expect(await utilizacoesNoErp()).toHaveLength(0);
  });

  it('a listagem do console filtra por conversa', async () => {
    await ate(CAMINHO_FELIZ, tetoBaixo());

    const lista = await app.inject({
      method: 'GET',
      url: `/api/console/reservas?conversaId=${conversaId}`,
      headers: { cookie },
    });
    expect(lista.statusCode).toBe(200);
    expect((lista.json() as { reservas: unknown[] }).reservas).toHaveLength(1);
  });
});

/**
 * Regressão encontrada em 17/09/2026 testando a demo no WhatsApp real: o
 * cotista escreveu "Gostaria de realizar uma reserva" e o agente abriu um
 * chamado para o comercial. O classificador (006) não tinha categoria para
 * reserva, então a frase caía em `comprar_cota` — que escala na raia do
 * cotista. Nenhum teste da 038 pegava isso porque todos entram por
 * `iniciarFluxo`, pulando o classificador.
 */
describe('o classificador leva a reserva ao fluxo, não ao comercial', { timeout: 60_000 }, () => {
  /** Turno COMPLETO pelo mesmo caminho do webhook. */
  async function turnoDe(texto: string): Promise<string> {
    const antes = (await db.select().from(traceTurno)).length;
    const res = await app.inject({
      method: 'POST',
      url: '/dev/inbound',
      headers: { cookie }, // com console presente o simulador exige sessão
      payload: { waId: WA_ID, text: texto },
    });
    expect(res.statusCode).toBe(202);
    for (let i = 0; i < 100 && (await db.select().from(traceTurno)).length === antes; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const linhas = await db.select().from(outbox).orderBy(asc(outbox.criadoEm), asc(outbox.seq));
    return linhas[linhas.length - 1]?.texto ?? '';
  }

  const ultimoTrace = async () => {
    const linhas = await db.select().from(traceTurno).orderBy(desc(traceTurno.criadoEm)).limit(1);
    return linhas[0];
  };

  beforeEach(async () => {
    fake = createFakeProvider();
    await db.delete(traceTurno);
    // os testes de HITL acima deixam tickets (e jobs em voo que ainda criam
    // outros) — zerar aqui é o único jeito de asserir "nenhum ticket novo"
    await db.delete(eventoTicket);
    await db.delete(ticket);
  });

  it('"gostaria de realizar uma reserva" ABRE o fluxo e não escala', async () => {
    fake.respondeTexto('reservar'); // só o classificador passa pelo LLM aqui
    const resposta = await turnoDe('Gostaria de realizar uma reserva');

    // o fluxo existe: a primeira pergunta da máquina é o período
    const ativo = await deps.repo.fluxoAtivo(conversaId);
    expect(ativo, 'o fluxo de reserva precisa ter sido aberto').toBeTruthy();
    // prova positiva: a máquina da 038 abre pedindo o PERÍODO
    expect(resposta).toMatch(/per[íi]odo/i);
    expect(resposta).not.toContain('equipe comercial');

    const trace = await ultimoTrace();
    expect(trace?.escalado, 'reserva não escala').toBe(false);
    // o ticket `bot_ativo` é o registro normal da conversa no console; o que
    // NÃO pode existir é ticket com motivo de escalonamento (ida ao comercial)
    const escalados = (await db.select().from(ticket)).filter(
      (x) => x.motivoEscalonamento !== null,
    );
    expect(escalados, 'nenhuma escalada para o comercial').toHaveLength(0);
  });

  it('interesse de COMPRA continua escalando na raia do cotista', async () => {
    fake.respondeTexto('comprar_cota');
    await turnoDe('quero comprar outra cota');

    const trace = await ultimoTrace();
    expect(trace?.escalado, 'comprar_cota com vínculo ainda é do comercial').toBe(true);
    expect(await deps.repo.fluxoAtivo(conversaId)).toBeFalsy();
  });
});

describe('um fluxo por conversa', () => {
  it('iniciar de novo encerra o anterior — o índice único nunca é violado', async () => {
    await iniciarFluxo(deps, ctxTurno('quero reservar'));
    await iniciarFluxo(deps, ctxTurno('quero reservar de novo'));

    const { rows } = await db.execute(
      sql`SELECT count(*)::int AS n FROM fluxo_reserva WHERE conversa_id = ${conversaId} AND etapa <> 'encerrado'`,
    );
    expect((rows[0] as { n: number }).n).toBe(1);
  });
});
