import { join } from 'node:path';
import { createFakeProvider } from '@seta/ai-provider/testing';
import {
  createAnonimizador,
  createAnonymizingProvider,
  createDicionarioDetector,
  createRegexDetector,
} from '@seta/anonimizacao';
import { loadClientConfig } from '@seta/client-config';
import { createPgConnector, type DbConnector } from '@seta/erp-connector';
import { createLogger, createNoopObsEmitter } from '@seta/observability';
import { createExecutor, type Executor, loadCatalog } from '@seta/query-catalog';
import { count } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminUrl, applySchema, seedData } from '../../../infra/erp-mock/seed.ts';
import {
  createAcumuladorAnonimizacao,
  montarProviderAnonimizado,
  nomesDoBanco,
} from '../src/anonimizacao.ts';
import { type App, buildApp } from '../src/app.ts';
import { FILA_DEBOUNCE, FILA_OUTBOX, startBoss } from '../src/boss.ts';
import { createDb, type Db } from '../src/db/index.ts';
import {
  chunk,
  conversa,
  documento,
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
import { createAgentTurnoHandler } from '../src/wa/turno-handler.ts';

/**
 * Critérios da 016 ponta a ponta VIA SIMULADOR: o turno inteiro (classificador
 * + agente) passa pelo decorator; o fake recebe só tokens; a resposta que sai
 * pelo outbox tem os valores reais; o trace registra quanto foi trocado.
 * Sem NER aqui (determinístico); o NER real tem suíte própria no package.
 */

const DEBOUNCE_MS = 400;
const WA_ID_VINCULADO = '5511999990001';
const CPF = '529.982.247-25';
const NOME = 'Renato Martins';
const logger = createLogger({ name: 'teste-anonimizacao', level: 'silent' });

let env: Env;
let db: Db;
let closeDb: () => Promise<void>;
let boss: Awaited<ReturnType<typeof startBoss>>;
let app: App;
let admin: pg.Pool;
let connector: DbConnector;
let executor: Executor;
let fake = createFakeProvider();
const acumulador = createAcumuladorAnonimizacao();

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

async function aguardarResposta() {
  await aguardar(async () => (await db.select({ n: count() }).from(traceTurno))[0]?.n === 1);
  const [trace] = await db.select().from(traceTurno);
  if (!trace) throw new Error('sem trace');
  const [linhaOutbox] = await db.select().from(outbox);
  return { resposta: linhaOutbox?.texto ?? '', trace };
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

  // o decorator envolve o fake ATUAL (beforeEach troca o fake); acumulador é um só
  const anonimizador = createAnonimizador({
    detectores: [createRegexDetector(), createDicionarioDetector({ nomes: nomesDoBanco(db) })],
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
        return createAnonymizingProvider(fake, { anonimizador, sink: acumulador.sink });
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
      anonimizacao: acumulador,
    }),
    logger,
  });
  app = buildApp({ env, clientConfig, wa: { db, boss } });
}, 60_000);

beforeEach(async () => {
  fake = createFakeProvider();
  await boss.deleteQueuedJobs(FILA_DEBOUNCE);
  await boss.deleteQueuedJobs(FILA_OUTBOX);
  for (let tentativa = 0; ; tentativa++) {
    try {
      await db.delete(chunk);
      await db.delete(documento);
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

describe('critérios spec 016 (via simulador)', () => {
  it('o turno inteiro sai tokenizado, a resposta volta real e o trace conta as trocas', async () => {
    fake
      .respondeTexto('outro') // classificador de intenção — também passa pelo decorator
      .respondeTexto('Anotado, [NOME_1]! Seu CPF [CPF_1] ficou registrado. 🙂');

    const res = await app.inject({
      method: 'POST',
      url: '/dev/inbound',
      payload: { waId: WA_ID_VINCULADO, text: `meu cpf é ${CPF}, sou o ${NOME}` },
    });
    expect(res.statusCode).toBe(202);
    const { resposta, trace } = await aguardarResposta();

    // 1) nada de PII chegou ao provedor — em NENHUMA das chamadas do turno
    const tudo = JSON.stringify(fake.requests);
    expect(fake.requests.length).toBe(2);
    for (const pii of [CPF, '52998224725', NOME, 'Renato', 'Martins']) {
      expect(tudo, `vazou: ${pii}`).not.toContain(pii);
    }
    expect(fake.requests[0]?.messages.at(-1)?.content).toBe('meu cpf é [CPF_1], sou o [NOME_1]');
    expect(fake.requests[1]?.messages.at(-1)?.content).toBe('meu cpf é [CPF_1], sou o [NOME_1]');

    // 2) o cotista recebe os valores reais
    expect(resposta).toBe(`Anotado, ${NOME}! Seu CPF ${CPF} ficou registrado. 🙂`);

    // 3) o trace prova quanto foi trocado, sem gravar o quê
    const eventos = trace.eventos as { tipo: string; [k: string]: unknown }[];
    const anon = eventos.find((e) => e.tipo === 'anonimizacao');
    expect(anon).toMatchObject({
      chamadas: 2,
      substituicoes: { cpf: 2, nome: 2 }, // 1 por chamada × 2 chamadas
      tokensDesconhecidos: 0,
    });
    expect(JSON.stringify(anon)).not.toContain('529');
  });

  it('o resumo rolante também passa pelo decorator e é persistido destokenizado', async () => {
    // resumo a cada 1 turno neste cenário: registra outro handler? não — usa o
    // resumidor direto pelo mesmo caminho: 3 chamadas (classificador, agente, resumo)
    fake
      .respondeTexto('outro')
      .respondeTexto('Certo, [NOME_1].')
      .respondeTexto('Cliente [NOME_1] informou o CPF [CPF_1].'); // resumo tokenizado pela LLM

    // força o resumo neste turno: contador já em 98 (resumoACadaTurnos = 99)
    await app.inject({
      method: 'POST',
      url: '/dev/inbound',
      payload: { waId: WA_ID_VINCULADO, text: `oi, sou o ${NOME}, cpf ${CPF}` },
    });
    await aguardarResposta();
    // primeiro turno criou a conversa; sobe o contador para o resumo disparar no próximo
    await db.update(conversa).set({ turnosDesdeResumo: 98 });
    await db.delete(traceTurno);
    await db.delete(outbox);

    fake = createFakeProvider()
      .respondeTexto('outro')
      .respondeTexto('Tudo certo, [NOME_1].')
      .respondeTexto('Cliente [NOME_1] informou o CPF [CPF_1]; quer saber do saldo.');
    await app.inject({
      method: 'POST',
      url: '/dev/inbound',
      payload: { waId: WA_ID_VINCULADO, text: 'e o saldo?' },
    });
    await aguardarResposta();

    expect(fake.requests.length).toBe(3);
    const chamadaResumo = JSON.stringify(fake.requests[2]);
    expect(chamadaResumo).not.toContain(CPF);
    expect(chamadaResumo).not.toContain(NOME);
    const [conv] = await db.select().from(conversa);
    // o que fica NO NOSSO banco tem os valores reais (retenção é a spec 022)
    expect(conv?.resumo).toBe(`Cliente ${NOME} informou o CPF ${CPF}; quer saber do saldo.`);
  });

  it('montarProviderAnonimizado: NER off ⇒ regex+dicionario; NER sem modelo ⇒ boot segue', async () => {
    const semNer = await montarProviderAnonimizado({
      env: { ...env, ANONIMIZACAO_NER: false },
      db,
      logger,
      provider: fake,
    });
    expect(semNer.detectores).toEqual(['regex', 'dicionario']);

    const nerIndisponivel = await montarProviderAnonimizado({
      env: {
        ...env,
        ANONIMIZACAO_NER: true,
        ANONIMIZACAO_MODELOS_DIR: '/nao/existe',
        ANONIMIZACAO_NER_DOWNLOAD: false,
      },
      db,
      logger,
      provider: fake,
    });
    expect(nerIndisponivel.detectores).toEqual(['regex', 'dicionario']);
  }, 60_000);
});
