import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { type Env, loadEnv } from '../src/env.ts';

const envTeste: Env = {
  NODE_ENV: 'test',
  PORT: 3001,
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgres://app_owner:x@localhost:5432/app',
  ERP_DATABASE_URL: 'postgres://erp_ro:x@localhost:5432/erp_mock',
  CLIENT_CONFIG_PATH: 'configs/demo/client.yaml',
};

const clientConfigTeste = {
  nome: 'TS Explorer Demo',
  persona: 'assistente de teste',
  modulos: { financeiro: true, contrato: true, atendimento: true },
  limites: { maxToolCallsPorTurno: 5, maxMensagensContexto: 30, maxCaracteresResposta: 2000 },
};

describe('apps/server', () => {
  it('GET /healthz responde 200 com status ok e nome do cliente', async () => {
    const app = buildApp({ env: envTeste, clientConfig: clientConfigTeste });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.cliente).toBe('TS Explorer Demo');
    await app.close();
  });

  it('loadEnv aplica defaults e rejeita DATABASE_URL inválida', () => {
    const env = loadEnv({
      DATABASE_URL: 'postgres://a:b@localhost:5432/app',
      ERP_DATABASE_URL: 'postgres://a:b@localhost:5432/erp_mock',
    } as NodeJS.ProcessEnv);
    expect(env.PORT).toBe(3001);
    expect(env.NODE_ENV).toBe('development');

    expect(() =>
      loadEnv({ DATABASE_URL: 'nada', ERP_DATABASE_URL: 'nada' } as NodeJS.ProcessEnv),
    ).toThrow(/Env inválida/);
  });
});
