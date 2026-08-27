import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // testes de integração compartilham o Postgres dev (seed trunca tabelas) — serial
    fileParallelism: false,
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts', 'tools/**/*.spec.ts'],
  },
});
