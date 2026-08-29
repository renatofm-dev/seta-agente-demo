import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb } from './db/index.js';
import { loadEnv } from './env.js';

/**
 * Migração programática (011): a imagem de produção não carrega drizzle-kit;
 * o deploy roda `node dist/migrate.js` antes de subir o server.
 */

export async function migrar(): Promise<void> {
  const env = loadEnv();
  const { db, close } = createDb(env.DATABASE_URL);
  try {
    await migrate(db, { migrationsFolder: join(import.meta.dirname, '../drizzle') });
    console.log('migrations aplicadas');
  } finally {
    await close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await migrar();
}
