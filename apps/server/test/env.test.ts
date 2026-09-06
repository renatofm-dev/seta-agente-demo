import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULTS_DE_DEV, EnvSchemaBase, loadEnv } from '../src/env.ts';

/**
 * P-28/P-31: o boot em produção recusa segredo de exemplo, e o .env.example
 * documenta toda variável que o server lê.
 */

const BASE = {
  DATABASE_URL: 'postgres://app_owner:senha-forte@db:5432/app',
  ERP_DATABASE_URL: 'postgres://erp_ro:outra-forte@db:5432/erp_mock',
};
const SEGREDOS_REAIS = {
  WA_VERIFY_TOKEN: 'tk-real',
  WA_APP_SECRET: 'segredo-real',
  BETTER_AUTH_SECRET: 'um-secret-longo-e-aleatorio-de-verdade',
};

describe('P-28: produção recusa valores de desenvolvimento', () => {
  it('development aceita os defaults (nada muda para quem roda local)', () => {
    const env = loadEnv({ ...BASE, NODE_ENV: 'development' });
    expect(env.WA_VERIFY_TOKEN).toBe(DEFAULTS_DE_DEV.WA_VERIFY_TOKEN);
  });

  it('production com os três defaults de dev NÃO sobe, e a mensagem nomeia cada um', () => {
    let erro = '';
    try {
      loadEnv({ ...BASE, NODE_ENV: 'production' });
    } catch (e) {
      erro = (e as Error).message;
    }
    for (const chave of Object.keys(DEFAULTS_DE_DEV)) expect(erro).toContain(chave);
    expect(erro).toContain('produção');
  });

  it('production com senha de dev na URL do banco NÃO sobe', () => {
    expect(() =>
      loadEnv({
        ...SEGREDOS_REAIS,
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://app_owner:app_owner_dev@db:5432/app',
        ERP_DATABASE_URL: BASE.ERP_DATABASE_URL,
      }),
    ).toThrow(/DATABASE_URL/);
  });

  it('production com segredos e senhas reais sobe', () => {
    const env = loadEnv({ ...BASE, ...SEGREDOS_REAIS, NODE_ENV: 'production' });
    expect(env.NODE_ENV).toBe('production');
  });
});

describe('P-31: .env.example documenta tudo que o server lê', () => {
  it('toda chave do EnvSchema aparece no .env.example (definida ou comentada)', () => {
    const exemplo = readFileSync(join(import.meta.dirname, '../../../.env.example'), 'utf-8');
    const documentadas = new Set(
      [...exemplo.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1] as string),
    );
    const faltando = Object.keys(EnvSchemaBase.shape).filter((k) => !documentadas.has(k));
    expect(faltando, `variáveis sem linha no .env.example: ${faltando.join(', ')}`).toEqual([]);
  });
});
