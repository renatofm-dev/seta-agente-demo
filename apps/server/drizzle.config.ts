import { loadEnvFile } from 'node:process';
import { defineConfig } from 'drizzle-kit';

// drizzle-kit roda com cwd em apps/server; o .env fica na raiz do monorepo.
try {
  loadEnvFile('../../.env');
} catch {
  // sem .env (ex.: CI) — DATABASE_URL precisa vir do ambiente
}

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL ausente (defina no .env da raiz)');

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url },
});
