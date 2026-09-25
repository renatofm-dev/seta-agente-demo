import { join } from 'node:path';
import { createFakeProvider } from '@seta/ai-provider/testing';
import { loadClientConfig } from '@seta/client-config';
import { createTseErpApi, type ErpWriter } from '@seta/erp-api-tse';
import { createPgConnector, type DbConnector } from '@seta/erp-connector';
import { createLogger, createNoopObsEmitter } from '@seta/observability';
import { createSimulatedPaymentProvider } from '@seta/payment-provider';
import { createExecutor, type Executor, loadCatalog } from '@seta/query-catalog';
import { asc, count, desc, eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminUrl, applySchema, seedData } from '../../../infra/erp-mock/seed.ts';
import { buildTseSimApp } from '../../tse-sim/src/app.ts';
import { criarBanco } from '../../tse-sim/src/db.ts';
import { loadEnv as loadEnvSim } from '../../tse-sim/src/env.ts';
import { type App, buildApp } from '../src/app.ts';
import { FILA_DEBOUNCE, FILA_ERP_VENDA, FILA_OUTBOX, startBoss } from '../src/boss.ts';
import { createDb, type Db } from '../src/db/index.ts';
import {
  cobranca,
  contato,
  conversa,
  conversaLeitura,
  erpEscrita,
  eventoPsp,
  eventoQuery,
  eventoTicket,
  fluxoSdr,
  lead,
  mensagem,
  outbox,
  pagamento,
  propostaSdr,
  sinalAprendizado,
  ticket,
  traceTurno,
  turno,
  venda,
} from '../src/db/schema.ts';
import { type Env, loadEnv } from '../src/env.ts';
import { registerCobrancaEmitirWorker } from '../src/pagamentos/emitir.ts';
import { registerCobrancaEventoWorker } from '../src/pagamentos/eventos.ts';
import { createPagamentosRepo } from '../src/pagamentos/repo.ts';
import { createDrizzleQueryEventSink } from '../src/query-event-sink.ts';
import { createPgVectorStore } from '../src/rag/pgvector-store.ts';
import { createSdrRepo } from '../src/sdr/repo.ts';
import { seedApp } from '../src/seed-app.ts';
import { createVendaRepo } from '../src/venda/repo.ts';
import { processarVenda } from '../src/venda/worker.ts';
import { registerDebounceWorker } from '../src/wa/debounce.ts';
import { createAgentTurnoHandler } from '../src/wa/turno-handler.ts';

/**
 * Spec 045 — a venda de ponta a ponta, VIA SIMULADOR de verdade.
 *
 * O caminho inteiro num teste só, porque é assim que ele quebra na vida real:
 * conversa → qualificação → oferta → aceite → nome e CPF → **PIX do sinal** →
 * webhook do PSP → `SetPessoa` + `setcasal` + `SetVenda` → contrato no ERP.
 *
 * O `fetchFn` do adapter entra no Fastify do `apps/tse-sim` por `inject`, sem
 * porta e sem rede — o mesmo caminho da 038. O efeito é conferido onde importa:
 * nas tabelas `contrato` e `contafinanceira` do `erp_mock`.
 *
 * Exige o Postgres dev de pé (docker compose -f infra/compose.dev.yml up -d).
 */

const LEAD_FRIO = '5511999990777'; // sem vínculo: raia do SDR
const WA_COTISTA = '5511999990001'; // contrato 10001: a raia que a 045 abriu
const SINAL = 200_000; // R$ 2.000,00
const DEBOUNCE_MS = 300;
const NOME = 'Joana Pereira Lima';
/** CPF fictício com DV válido — prefixo 000, como todo CPF do repo. */
const CPF = '00035417544';

const logger = createLogger({ name: 'teste-045', level: 'silent' });
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
let simApp: Awaited<ReturnType<typeof buildTseSimApp>>;
let simDb: ReturnType<typeof criarBanco>;
let writer: ErpWriter;
let fake = createFakeProvider();
const psp = createSimulatedPaymentProvider();

/** O adapter fala com o simulador por inject — sem porta, sem rede. */
const fetchNoSimulador: typeof fetch = async (entrada, init) => {
  const url = new URL(typeof entrada === 'string' ? entrada : String(entrada));
  const r = await simApp.inject({
    method: (init?.method ?? 'GET') as 'GET' | 'POST',
    url: url.pathname + url.search,
    headers: init?.headers as Record<string, string>,
    payload: init?.body as string,
  });
  return new Response(r.body, { status: r.statusCode, headers: r.headers as HeadersInit });
};

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

async function turnoDe(waId: string, text: string): Promise<string> {
  const antes = await traces();
  const res = await app.inject({ method: 'POST', url: '/dev/inbound', payload: { waId, text } });
  expect(res.statusCode).toBe(202);
  await aguardar(async () => (await traces()) === antes + 1);
  const linhas = await db.select().from(outbox).orderBy(asc(outbox.criadoEm), asc(outbox.seq));
  return linhas[linhas.length - 1]?.texto ?? '';
}

/** Leva a conversa até o PIX do sinal sair. Devolve a venda criada. */
async function ateOSinal(waId: string, dados?: string) {
  fake.respondeTexto('comprar_cota');
  await turnoDe(waId, 'quero comprar uma cota');
  await turnoDe(waId, '4'); // pessoas
  await turnoDe(waId, '2'); // períodos por ano
  await turnoDe(waId, '1'); // escolhe a primeira opção
  await turnoDe(waId, 'fechado'); // aceita
  if (dados) await turnoDe(waId, dados);
  await aguardar(async () => (await db.select().from(venda)).length > 0);
  const [v] = await db.select().from(venda).orderBy(desc(venda.criadoEm)).limit(1);
  if (!v) throw new Error('venda não criada');
  return v;
}

/** Simula o Asaas avisando que o PIX caiu. */
async function pagar(cobrancaId: string, eventoId = `evt_${Date.now()}`) {
  const [c] = await db.select().from(cobranca).where(eq(cobranca.id, cobrancaId));
  if (!c) throw new Error('cobrança inexistente');
  const r = await app.inject({
    method: 'POST',
    url: '/webhooks/asaas',
    headers: { 'asaas-access-token': env.ASAAS_WEBHOOK_TOKEN ?? '' },
    payload: {
      id: eventoId,
      event: 'PAYMENT_RECEIVED',
      payment: {
        id: c.pspCobrancaId,
        status: 'RECEIVED',
        value: c.valorCentavos / 100,
        externalReference: c.referenciaExterna,
        paymentDate: '2026-09-18',
      },
    },
  });
  expect(r.statusCode).toBe(200);
}

async function limpar(): Promise<void> {
  for (let tentativa = 0; ; tentativa++) {
    try {
      await db.delete(venda);
      await db.delete(erpEscrita);
      await db.delete(pagamento);
      await db.delete(eventoPsp);
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
      await db.delete(contato).where(eq(contato.waId, LEAD_FRIO));
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
      VENDA_SINAL_CENTAVOS: String(SINAL),
      ASAAS_WEBHOOK_TOKEN: 'token-de-teste-do-webhook-asaas-0123456789',
    } as NodeJS.ProcessEnv),
    WA_DEBOUNCE_MS: DEBOUNCE_MS,
  };

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
      TSE_SIM_USERS: 'integracao:integracao:1,AGENTE.SETA:agente:1',
    }),
    db: simDb,
  });
  await simApp.ready();
  writer = createTseErpApi({
    baseUrl: 'http://tse-sim:3010',
    username: 'AGENTE.SETA',
    password: 'agente',
    fetchFn: fetchNoSimulador,
    esperar: async () => {},
  });

  connector = createPgConnector({ url: env.ERP_DATABASE_URL, poolMax: 3 });
  const catalog = await loadCatalog(join(import.meta.dirname, '../../../catalog'));
  executor = createExecutor({ catalog, connector, sink: createDrizzleQueryEventSink(db) });
  boss = await startBoss(env.DATABASE_URL, logger);

  const pagamentosRepo = createPagamentosRepo(db);
  const vendaRepo = createVendaRepo(db);

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
      pagamentos: { repo: pagamentosRepo, psp, env },
      sdr: { repo: createSdrRepo(db), env },
      venda: { repo: vendaRepo, pspNome: psp.nome }, // 045
    }),
    logger,
  });
  await registerCobrancaEmitirWorker({
    db,
    boss,
    repo: pagamentosRepo,
    psp,
    logger,
    nomeCliente: clientConfig.nome,
    env,
    pixRecebedor: { merchantName: 'SETA TECH LTDA', key: 'chave-pix-teste', keyType: 'EVP' },
  });
  await registerCobrancaEventoWorker({
    db,
    boss,
    repo: pagamentosRepo,
    gateway: {
      async send() {
        return { waMessageId: 'wamid.x' };
      },
      async sendTemplate() {
        return { waMessageId: 'wamid.tpl' };
      },
    },
    env,
    logger,
  });

  app = buildApp({
    env,
    clientConfig,
    wa: { db, boss },
    pagamentos: { repo: pagamentosRepo, psp },
  });
}, 120_000);

beforeEach(async () => {
  fake = createFakeProvider();
  await boss.deleteQueuedJobs(FILA_DEBOUNCE);
  await boss.deleteQueuedJobs(FILA_OUTBOX);
  await boss.deleteQueuedJobs(FILA_ERP_VENDA);
  await limpar();
});

afterAll(async () => {
  await limpar();
  await app?.close();
  await boss?.stop({ graceful: false });
  await simApp?.close();
  await simDb?.fechar();
  await connector?.close();
  await closeDb?.();
  if (admin) await seedData(admin);
  await admin?.end();
}, 120_000);

const deps = () => ({
  db,
  boss,
  writer,
  logger,
  idProdutoPadrao: env.VENDA_ID_PRODUTO,
  idMeioPagamentoSinal: env.VENDA_MEIO_PAGAMENTO_SINAL,
  idMeioPagamentoSaldo: env.VENDA_MEIO_PAGAMENTO_SALDO,
});

describe('a conversa vira um PIX de sinal', { timeout: 120_000 }, () => {
  it('lead frio: qualifica, oferta, aceita, informa CPF e recebe o sinal', async () => {
    const v = await ateOSinal(LEAD_FRIO, `meu nome é ${NOME}, CPF ${CPF}`);

    expect(v.status).toBe('sinal_emitido');
    expect(v.sinalCentavos).toBe(SINAL);
    expect(v.valorCentavos).toBeGreaterThan(SINAL);
    expect((v.comprador as { cpf: string }).cpf).toBe(CPF);

    // a cobrança do sinal existe, é PIX e tem origem `venda`
    const [c] = await db
      .select()
      .from(cobranca)
      .where(eq(cobranca.id, v.cobrancaId ?? ''));
    expect(c?.origem).toBe('venda');
    expect(c?.metodo).toBe('pix');
    expect(c?.valorCentavos).toBe(SINAL);
  });

  it('o CPF chega ao contato — é o que permite o PSP criar o cliente', async () => {
    await ateOSinal(LEAD_FRIO, `${NOME} — ${CPF}`);

    const [ct] = await db.select().from(contato).where(eq(contato.waId, LEAD_FRIO));
    expect(ct?.documento).toBe(CPF);
    // e o número CONTINUA sem vínculo: a raia do SDR vale até a venda existir
    expect(ct?.clienteErpId).toBe('');
  });

  /**
   * O teste que a spec exige nominalmente: o CPF vem do PARSER sobre o texto
   * cru. Se o token de anonimização (016) vazasse para cá, ele iria para o
   * Asaas e para o TSE como se fosse documento de gente.
   */
  it('token de anonimização NÃO é aceito como CPF', async () => {
    fake.respondeTexto('comprar_cota');
    await turnoDe(LEAD_FRIO, 'quero comprar uma cota');
    await turnoDe(LEAD_FRIO, '4');
    await turnoDe(LEAD_FRIO, '2');
    await turnoDe(LEAD_FRIO, '1');
    await turnoDe(LEAD_FRIO, 'fechado');
    await turnoDe(LEAD_FRIO, `sou ${NOME}, CPF [CPF_1]`);

    // nenhuma venda: o fluxo continua pedindo os dados
    expect(await db.select().from(venda)).toHaveLength(0);
    const [ct] = await db.select().from(contato).where(eq(contato.waId, LEAD_FRIO));
    expect(ct?.documento ?? '').not.toContain('CPF_1');
  });

  it('cotista não precisa informar CPF: o cadastro já tem', async () => {
    // sem a mensagem de dados — a etapa é pulada na raia do cotista
    const v = await ateOSinal(WA_COTISTA);

    expect(v.status).toBe('sinal_emitido');
    const c = v.comprador as { nome: string; cpf: string };
    expect(c.cpf).toBe('52998224725'); // documento do contatos.yaml
  });
});

describe('o sinal pago vira contrato no ERP', { timeout: 120_000 }, () => {
  it('cria pessoa, casal e venda — e o contrato existe com as parcelas', async () => {
    const v = await ateOSinal(LEAD_FRIO, `${NOME}, CPF ${CPF}`);
    await aguardar(async () => {
      const [c] = await db
        .select()
        .from(cobranca)
        .where(eq(cobranca.id, v.cobrancaId ?? ''));
      return c?.status === 'emitida';
    });
    await pagar(v.cobrancaId as string);

    // o evento marca `sinal_pago` e registra a escrita pendente
    await aguardar(async () => {
      const [l] = await db.select().from(venda).where(eq(venda.id, v.id));
      return l?.status === 'sinal_pago';
    });

    expect(await processarVenda(deps(), v.id)).toBe('registrada');

    const [depois] = await db.select().from(venda).where(eq(venda.id, v.id));
    expect(depois?.status).toBe('registrada');
    expect(depois?.erpPessoaId).toBeTruthy();
    expect(depois?.erpCasalId).toBeTruthy();
    expect(depois?.erpContratoId).toBeTruthy();

    // o contrato existe MESMO, no erp_mock, com titular e parcelas
    const contratoId = Number(depois?.erpContratoId);
    const { rows } = await admin.query(
      `SELECT c.idcontrato, c.statuscontrato, p.cpf, p.nome,
              (SELECT count(*) FROM contafinanceira f WHERE f.idcontrato = c.idcontrato) AS parcelas
         FROM contrato c JOIN pessoa p ON p.idpessoa = c.idpessoatitular
        WHERE c.idcontrato = $1`,
      [contratoId],
    );
    const linha = rows[0] as { statuscontrato: string; cpf: string; parcelas: string };
    expect(linha.statuscontrato).toBe('ATIVO');
    expect(linha.cpf.replace(/\D/g, '')).toBe(CPF);
    // entrada (o sinal) + saldo
    expect(Number(linha.parcelas)).toBe(2);

    // e a cota saiu do estoque — senão o SDR ofereceria a mesma ao próximo lead
    const cota = await admin.query('SELECT statuscota FROM cotauh WHERE idcotauh = $1', [
      Number(depois?.cotaId),
    ]);
    expect((cota.rows[0] as { statuscota: string }).statuscota).toBe('VENDIDA');
  });

  it('reprocessar NÃO cria segundo contrato', async () => {
    const v = await ateOSinal(LEAD_FRIO, `${NOME}, CPF ${CPF}`);
    await aguardar(async () => {
      const [c] = await db
        .select()
        .from(cobranca)
        .where(eq(cobranca.id, v.cobrancaId ?? ''));
      return c?.status === 'emitida';
    });
    await pagar(v.cobrancaId as string);
    await aguardar(async () => {
      const [l] = await db.select().from(venda).where(eq(venda.id, v.id));
      return l?.status === 'sinal_pago';
    });

    expect(await processarVenda(deps(), v.id)).toBe('registrada');
    const [primeira] = await db.select().from(venda).where(eq(venda.id, v.id));

    // segunda passada: a guarda de `erp_escrita` não deixa escrever de novo
    expect(await processarVenda(deps(), v.id)).toBe('ja-resolvida');
    const [segunda] = await db.select().from(venda).where(eq(venda.id, v.id));
    expect(segunda?.erpContratoId).toBe(primeira?.erpContratoId);

    const { rows } = await admin.query(
      'SELECT count(*)::int AS n FROM contrato WHERE idcontrato = $1',
      [Number(primeira?.erpContratoId)],
    );
    expect((rows[0] as { n: number }).n).toBe(1);
  });

  it('sem pagamento, NADA é escrito no ERP', async () => {
    const v = await ateOSinal(LEAD_FRIO, `${NOME}, CPF ${CPF}`);

    // nenhuma escrita pendente foi registrada — o worker não tem o que fazer
    expect(await db.select().from(erpEscrita)).toHaveLength(0);
    expect(await processarVenda(deps(), v.id)).toBe('ja-resolvida');

    const [linha] = await db.select().from(venda).where(eq(venda.id, v.id));
    expect(linha?.erpContratoId).toBeNull();
  });

  it('reentrega do webhook não enfileira a venda duas vezes', async () => {
    const v = await ateOSinal(LEAD_FRIO, `${NOME}, CPF ${CPF}`);
    await aguardar(async () => {
      const [c] = await db
        .select()
        .from(cobranca)
        .where(eq(cobranca.id, v.cobrancaId ?? ''));
      return c?.status === 'emitida';
    });
    await pagar(v.cobrancaId as string, 'evt_dup_1');
    await aguardar(async () => (await db.select().from(erpEscrita)).length === 1);
    await pagar(v.cobrancaId as string, 'evt_dup_2');

    // uma linha de escrita, uma só — a chave é a PK e o insert é DO NOTHING
    await new Promise((r) => setTimeout(r, 500));
    expect(await db.select().from(erpEscrita)).toHaveLength(1);
  });
});

/**
 * 045: a raia do cotista passou a ter TRÊS fluxos (cobrança, reserva, venda).
 * A precedência é a ordem dos blocos de "fluxo ativo" no `turno-handler`, e
 * estes casos travam o que ela significa na prática.
 */
describe('precedência na raia do cotista', { timeout: 120_000 }, () => {
  it('com o sinal emitido, o fluxo segura o turno e NÃO conta não-entendi', async () => {
    const v = await ateOSinal(WA_COTISTA);
    expect(v.status).toBe('sinal_emitido');

    /**
     * Qualquer assunto enquanto o PIX não cai TEM RESPOSTA — e ela é uma de
     * duas: o PIX reenviado (046: quem escreve aqui quase sempre pergunta "cadê
     * o pix?") ou a frase de que o pagamento não foi identificado, quando o
     * reenvio não acontece (já reenviado antes, ou cobrança ainda não emitida).
     * O que este teste trava é a INVARIANTE: nunca silêncio, e o fluxo não cai.
     *
     * A busca é em TODAS as linhas do outbox, não na última: o card do PIX e o
     * copia-e-cola são enviados pelo worker de cobrança e se intercalam com as
     * respostas do turno — foi exatamente assim que este teste falhou primeiro.
     */
    const respondeu = async (texto: string): Promise<boolean> => {
      const antes = (await db.select().from(outbox)).length;
      await turnoDe(WA_COTISTA, texto);
      const linhas = await db.select().from(outbox);
      const houveResposta = linhas.length > antes;
      const respostaEsperada = linhas.some(
        (l) =>
          l.texto.includes('Ainda não identifiquei o pagamento') || l.texto.includes('reenviando'),
      );
      return houveResposta && respostaEsperada;
    };
    expect(await respondeu('e a minha parcela de setembro?')).toBe(true);
    expect(await respondeu('tudo bem então')).toBe(true);

    // duas respostas "não entendidas" NÃO derrubam o fluxo: a cobrança está
    // emitida e sair daqui perderia o contexto dela
    const [fluxo] = await db.select().from(fluxoSdr);
    expect(fluxo?.etapa).toBe('fechamento');
    expect(fluxo?.naoEntendi).toBe(0);
  });

  it('pedido explícito de humano tira o cotista do fluxo', async () => {
    await ateOSinal(WA_COTISTA);
    await turnoDe(WA_COTISTA, 'prefiro falar com um atendente');

    const [fluxo] = await db.select().from(fluxoSdr);
    expect(fluxo?.etapa).toBe('agendamento');
  });
});
