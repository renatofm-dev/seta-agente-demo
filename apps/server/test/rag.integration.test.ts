import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeProvider } from '@seta/ai-provider/testing';
import { loadClientConfig } from '@seta/client-config';
import { createPgConnector, type DbConnector } from '@seta/erp-connector';
import { createNoopObsEmitter, newTraceId } from '@seta/observability';
import { createExecutor, type Executor, loadCatalog } from '@seta/query-catalog';
import { and, count, eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminUrl, applySchema, seedData } from '../../../infra/erp-mock/seed.ts';
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
import { ingestKb } from '../src/kb-ingest.ts';
import { createDrizzleQueryEventSink } from '../src/query-event-sink.ts';
import { createPgVectorStore } from '../src/rag/pgvector-store.ts';
import { seedApp } from '../src/seed-app.ts';
import { registerDebounceWorker } from '../src/wa/debounce.ts';
import { createAgentTurnoHandler } from '../src/wa/turno-handler.ts';

/**
 * Critérios da spec 008: ingestão incremental por hash, híbrida > densa com
 * termo exato, índice HNSW, e pergunta de política respondida via KB com fonte.
 */

const DEBOUNCE_MS = 400;
const WA_ID = '5511999990001';
const DIM = 8; // fake provider embeda em 8 dims

let env: Env;
let db: Db;
let closeDb: () => Promise<void>;
let boss: Awaited<ReturnType<typeof startBoss>>;
let app: App;
let admin: pg.Pool;
let connector: DbConnector;
let executor: Executor;
let store: ReturnType<typeof createPgVectorStore>;
let fake = createFakeProvider();
let embedTextos = 0; // contador do critério de re-ingestão

const clientConfig = loadClientConfig(
  join(import.meta.dirname, '../../../configs/demo/client.yaml'),
);
const catalog = loadCatalog(join(import.meta.dirname, '../../../catalog'));
const FIXTURES = join(import.meta.dirname, 'fixtures/kb');

const embedContando = async (textos: readonly string[]): Promise<number[][]> => {
  embedTextos += textos.length;
  const vs = await fake.embed(textos);
  return vs.map((v) => Array.from(v));
};

async function aguardar(cond: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const inicio = Date.now();
  while (Date.now() - inicio < timeoutMs) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('condição não atingida no tempo');
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
      SKILLS_SEED_DIR: join(import.meta.dirname, '../../../skills-seed'),
      EMBEDDING_DIM: String(DIM),
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
  store = createPgVectorStore({ db, dim: DIM });
  // chunks de outra dimensão (ex.: dev com modelo real) quebrariam a recriação do índice
  await db.delete(chunk);
  await db.delete(documento);
  await store.ensureIndex();

  const { createLogger } = await import('@seta/observability');
  const logger = createLogger({ name: 'teste-rag', level: 'silent' });
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
      registry: null, // skills fora destes cenários
      store,
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
  embedTextos = 0;
});

afterAll(async () => {
  await boss?.stop({ graceful: false });
  await connector?.close();
  await closeDb?.();
  await admin?.end();
});

describe('008 — ingestão da KB', () => {
  it('re-ingestão sem mudanças não regrava embeddings (hash); mudança re-embeda só o arquivo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kb-'));
    try {
      cpSync(FIXTURES, dir, { recursive: true });

      const r1 = await ingestKb({ db, store, embed: embedContando, dir });
      expect(r1).toMatchObject({ arquivos: 3, inalterados: 0, reingeridos: 3 });
      expect(embedTextos).toBeGreaterThan(0);
      const docs = await db.select().from(documento).where(eq(documento.ns, 'kb'));
      expect(docs).toHaveLength(3);
      const chunks1 = await db.select().from(chunk).where(eq(chunk.ns, 'kb'));
      expect(chunks1.every((c) => c.embedding !== null)).toBe(true);

      // rodada 2: nada mudou ⇒ zero chamadas de embed, mesmos chunk ids
      const antes = embedTextos;
      const r2 = await ingestKb({ db, store, embed: embedContando, dir });
      expect(r2).toMatchObject({ arquivos: 3, inalterados: 3, reingeridos: 0, chunks: 0 });
      expect(embedTextos).toBe(antes);
      const chunks2 = await db.select().from(chunk).where(eq(chunk.ns, 'kb'));
      expect(chunks2.map((c) => c.id).sort()).toEqual(chunks1.map((c) => c.id).sort());

      // rodada 3: 1 arquivo editado ⇒ só ele re-embeda; versão incrementa
      writeFileSync(
        join(dir, 'entrega.md'),
        '# Política de entrega e prazos\n\nPrazo novo: 3 dias.\n',
      );
      const r3 = await ingestKb({ db, store, embed: embedContando, dir });
      expect(r3).toMatchObject({ arquivos: 3, inalterados: 2, reingeridos: 1 });
      const [docEntrega] = await db
        .select()
        .from(documento)
        .where(and(eq(documento.ns, 'kb'), eq(documento.fonte, 'entrega.md')));
      expect(docEntrega?.versao).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('ensureIndex cria o índice HNSW (expressão com a dimensão do env)', async () => {
    const r = await db.execute(
      sql`SELECT indexdef FROM pg_indexes WHERE indexname = 'chunk_embedding_hnsw'`,
    );
    const def = (r.rows[0] as { indexdef?: string } | undefined)?.indexdef ?? '';
    expect(def).toContain('USING hnsw');
    expect(def).toContain(`vector(${DIM})`);
  });
});

describe('008 — busca híbrida', () => {
  it('híbrida supera só-densa com termo exato (código de produto)', async () => {
    // corpus com ranking denso construído para errar: o chapa (decoy) tem
    // embedding idêntico ao da consulta; o alvo (com o código) é ortogonal
    const q = [1, 0, 0, 0, 0, 0, 0, 0];
    const alvoId = newTraceId();
    await store.upsert('kb', [
      {
        id: newTraceId(),
        texto: 'Guia geral de conexões e adaptadores para instalação.',
        fonte: 'guia.md',
        titulo: 'Guia de conexões',
        metadados: {},
        embedding: [1, 0, 0, 0, 0, 0, 0, 0],
      },
      {
        id: alvoId,
        texto: 'O item TSX-9012 tem troca garantida apenas por defeito de fabricação.',
        fonte: 'trocas.md',
        titulo: 'Política de trocas e devoluções',
        metadados: {},
        embedding: [0, 1, 0, 0, 0, 0, 0, 0],
      },
    ]);

    const densa = await store.search('kb', q, 2);
    expect(densa[0]?.texto).not.toContain('TSX-9012'); // densa erra o topo

    const hibrida = await store.hybrid('kb', 'TSX-9012', q, 2);
    expect(hibrida[0]?.id).toBe(alvoId); // lexical resgata o termo exato via RRF
    expect(hibrida[0]?.texto).toContain('TSX-9012');
  });
});

describe('008 — pergunta de política via turno', () => {
  it('buscar_conhecimento responde com trecho da KB e a resposta cita a fonte', async () => {
    await ingestKb({ db, store, embed: embedContando, dir: FIXTURES });

    fake
      .respondeTexto('outro') // classificador de intenção (006)
      .chamaTool('buscar_conhecimento', { pergunta: 'como funciona troca devolução prazo' })
      .respondeTexto(
        'Segundo a nossa Política de trocas e devoluções, você pode solicitar a troca em até 7 dias corridos após o recebimento. Precisa da nota fiscal e do produto sem uso!',
      );

    const antes = (await db.select({ n: count() }).from(traceTurno))[0]?.n ?? 0;
    const res = await app.inject({
      method: 'POST',
      url: '/dev/inbound',
      payload: { waId: WA_ID, text: 'como funciona troca?' },
    });
    expect(res.statusCode).toBe(202);
    await aguardar(
      async () => ((await db.select({ n: count() }).from(traceTurno))[0]?.n ?? 0) > antes,
    );

    const [trace] = await db.select().from(traceTurno);
    const eventos = trace?.eventos as Array<{
      tipo: string;
      nome?: string;
      resultado?: unknown;
    }>;
    const evTool = eventos.find((e) => e.tipo === 'tool' && e.nome === 'buscar_conhecimento');
    expect(evTool).toBeDefined();
    const resultado = JSON.stringify(evTool?.resultado ?? {});
    expect(resultado).toContain('Política de trocas e devoluções'); // fonte amigável
    expect(resultado).toContain('7 dias corridos'); // trecho veio da KB

    // resposta final cita a fonte (prompt-base instrui; aqui o replay comprova o fluxo)
    expect(trace?.resposta).toContain('Política de trocas e devoluções');
    const [saida] = await db.select().from(outbox);
    expect(saida?.texto).toContain('7 dias corridos');
  }, 20_000);
});
