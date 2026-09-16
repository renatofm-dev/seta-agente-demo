import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EnvSchemaBase, loadEnv, SENHA_DE_DEV, USERS_DE_DEV } from '../src/env.ts';

/**
 * Mesmas garantias que o server tem desde a P-28/P-31, agora para o simulador:
 * produção não sobe com credencial de exemplo, e o `.env.example` documenta
 * toda variável que este serviço lê.
 */

describe('produção recusa o que só serve em dev', () => {
  it('dev sobe com os defaults (ninguém precisa configurar nada local)', () => {
    const env = loadEnv({});
    expect(env.TSE_SIM_PORT).toBe(3010);
    expect(env.TSE_SIM_PAINEL_ESCOPO).toBe('qualquer');
  });

  it('produção com a senha de dev no banco NÃO sobe', () => {
    expect(() =>
      loadEnv({
        NODE_ENV: 'production',
        TSE_SIM_USERS: 'operador:senha-real:1',
        TSE_SIM_DATABASE_URL: `postgres://tse_sim:${SENHA_DE_DEV}@db:5432/erp_mock`,
      }),
    ).toThrow(/TSE_SIM_DATABASE_URL/);
  });

  it('produção com a credencial de exemplo do /token NÃO sobe', () => {
    expect(() =>
      loadEnv({
        NODE_ENV: 'production',
        TSE_SIM_USERS: USERS_DE_DEV,
        TSE_SIM_DATABASE_URL: 'postgres://tse_sim:forte@db:5432/erp_mock',
      }),
    ).toThrow(/TSE_SIM_USERS/);
  });

  it('produção com credencial real sobe', () => {
    const env = loadEnv({
      NODE_ENV: 'production',
      TSE_SIM_USERS: 'operador:senha-real:1',
      TSE_SIM_DATABASE_URL: 'postgres://tse_sim:forte@db:5432/erp_mock',
    });
    expect(env.NODE_ENV).toBe('production');
  });
});

describe('P-31: o .env.example documenta tudo que o simulador lê', () => {
  it('toda chave TSE_SIM_* do schema aparece no .env.example', () => {
    const exemplo = readFileSync(join(import.meta.dirname, '../../../.env.example'), 'utf-8');
    const documentadas = new Set(
      [...exemplo.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1] as string),
    );
    const faltando = Object.keys(EnvSchemaBase.shape)
      .filter((k) => k.startsWith('TSE_SIM_'))
      .filter((k) => !documentadas.has(k));
    expect(faltando, `sem linha no .env.example: ${faltando.join(', ')}`).toEqual([]);
  });
});
