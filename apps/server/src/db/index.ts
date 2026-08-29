import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;

export function createDb(url: string): { db: Db; close(): Promise<void> } {
  // #37: banco fora do ar falha rápido em vez de pendurar o connect
  const pool = new pg.Pool({ connectionString: url, max: 5, connectionTimeoutMillis: 5_000 });
  return { db: drizzle(pool, { schema }), close: () => pool.end() };
}
