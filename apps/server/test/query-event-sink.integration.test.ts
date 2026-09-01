import { join } from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../src/db/index.ts';
import { eventoQuery } from '../src/db/schema.ts';
import { createDrizzleQueryEventSink } from '../src/query-event-sink.ts';

/**
 * Critério 003 (persistência): evento_query gravado no banco `app` com
 * latência e linhas. Exige o Postgres dev de pé.
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://app_owner:app_owner_dev@localhost:5432/app';

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  const criado = createDb(DATABASE_URL);
  db = criado.db;
  close = criado.close;
  try {
    await migrate(db, { migrationsFolder: join(import.meta.dirname, '../drizzle') });
  } catch (err) {
    throw new Error(
      'Postgres dev indisponível — suba com: docker compose -f infra/compose.dev.yml up -d --wait',
      { cause: err },
    );
  }
}, 30_000);

afterAll(async () => {
  await close?.();
});

describe('sink drizzle de evento_query', () => {
  it('grava evento com latência, linhas e traceId', async () => {
    const sink = createDrizzleQueryEventSink(db);
    const traceId = `teste-${Date.now()}`;
    await sink.record({
      traceId,
      entryId: 'contrato.minha_cota',
      ok: true,
      latencyMs: 12,
      linhas: 1,
      truncated: false,
    });

    const linhas = await db.select().from(eventoQuery);
    const gravado = linhas.find((l) => l.traceId === traceId);
    expect(gravado).toBeDefined();
    expect(gravado).toMatchObject({
      entryId: 'contrato.minha_cota',
      ok: true,
      latencyMs: 12,
      linhas: 1,
      truncated: false,
      erro: null,
    });
    expect(gravado?.id).toMatch(/^[0-9a-f-]{36}$/); // UUIDv7
    expect(gravado?.criadoEm).toBeInstanceOf(Date);
  });
});
