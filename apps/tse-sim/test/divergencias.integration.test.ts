import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminUrl,
  applySchema,
  CONTRATO_DEMO_EM_DIA,
  CONTRATO_DEMO_INADIMPLENTE,
  seedData,
} from '../../../infra/erp-mock/seed.ts';
import type { App } from '../src/app.ts';
import { buildTseSimApp } from '../src/app.ts';
import { type Banco, criarBanco } from '../src/db.ts';
import { loadEnv } from '../src/env.ts';

/**
 * O que o simulador DOCUMENTA sobre o fornecedor — as duas coisas que a coleção
 * deixou no ar e que o adapter (036/037) vai encontrar de frente:
 *
 *  1. `/token` está salvo como GET COM BODY. O `fetch` do Node recusa body em
 *     GET, então a rota existe mas só lê query string; quem chama usa POST.
 *  2. D10, o risco nº 1 da frente: se o painel resolver escopo pelo DONO DO
 *     TOKEN, uma credencial só não atende N cotistas — e a leitura financeira
 *     por API não serve. Enquanto o fornecedor não responde, os dois mundos
 *     rodam aqui, e o adapter pode ser exercitado contra o pior deles.
 *
 * Exige o Postgres dev de pé (docker compose -f infra/compose.dev.yml up -d).
 */

const BASE = {
  NODE_ENV: 'test' as const,
  LOG_LEVEL: 'silent' as const,
  TSE_SIM_DATABASE_URL:
    process.env.TSE_SIM_DATABASE_URL ?? 'postgres://tse_sim:tse_sim_dev@localhost:5432/erp_mock',
  // o titular do contrato EM DIA (10001) é a pessoa 1 no seed da 012
  TSE_SIM_USERS: 'integracao:integracao:1',
};

let admin: pg.Pool;
let db: Banco;
const apps: App[] = [];

async function appComEscopo(escopo: 'qualquer' | 'token'): Promise<App> {
  const app = buildTseSimApp({
    env: loadEnv({ ...BASE, TSE_SIM_PAINEL_ESCOPO: escopo }),
    db,
  });
  await app.ready();
  apps.push(app);
  return app;
}

async function bearerDe(app: App): Promise<string> {
  const r = await app.inject({
    method: 'POST',
    url: '/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'grant_type=password&username=integracao&password=integracao',
  });
  return `Bearer ${(r.json() as { access_token: string }).access_token}`;
}

beforeAll(async () => {
  admin = new pg.Pool({ connectionString: adminUrl(), max: 2 });
  await applySchema(admin);
  await seedData(admin);
  db = criarBanco(BASE.TSE_SIM_DATABASE_URL);
}, 120_000);

afterAll(async () => {
  await Promise.all(apps.map((a) => a.close()));
  await db?.fechar();
  await admin?.end();
});

describe('divergência: /token está salvo como GET com body', () => {
  it('POST /token devolve o envelope do exemplo (86399, bearer)', async () => {
    const app = await appComEscopo('qualquer');
    const r = await app.inject({
      method: 'POST',
      url: '/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'grant_type=password&username=integracao&password=integracao',
    });
    expect(r.statusCode).toBe(200);
    const envelope = r.json() as Record<string, unknown>;
    expect(envelope.token_type).toBe('bearer');
    expect(envelope.expires_in).toBe(86_399);
    expect(envelope.userName).toBe('integracao');
  });

  it('GET /token existe, mas as credenciais só cabem na query — body em GET o Node recusa', async () => {
    const app = await appComEscopo('qualquer');
    const r = await app.inject({
      method: 'GET',
      url: '/token?grant_type=password&username=integracao&password=integracao',
    });
    expect(r.statusCode).toBe(200);
    expect((r.json() as { token_type: string }).token_type).toBe('bearer');
    // a prova da divergência: é o próprio runtime que impede o que a coleção mostra
    expect(() => new Request('http://x/token', { method: 'GET', body: 'a=1' })).toThrow();
  });

  it('sem bearer, qualquer rota do painel responde 401 no formato do TSE', async () => {
    const app = await appComEscopo('qualquer');
    const r = await app.inject({ method: 'GET', url: '/api/PainelDoCliente/MeusContratos' });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ Message: 'Authorization has been denied for this request.' });
  });
});

describe('D10: o painel resolve escopo pelo dono do token?', () => {
  it('`qualquer` — uma credencial lê o financeiro de qualquer contrato (a demo funciona)', async () => {
    const app = await appComEscopo('qualquer');
    const bearer = await bearerDe(app);
    const r = await app.inject({
      method: 'GET',
      url: `/api/PainelDoCliente/FinanceiroContrato?idContrato=${CONTRATO_DEMO_INADIMPLENTE}&paginaAtual=1`,
      headers: { authorization: bearer },
    });
    expect((r.json() as { QtdParcelasTotal: number }).QtdParcelasTotal).toBeGreaterThan(0);
    const contratos = await app.inject({
      method: 'GET',
      url: '/api/PainelDoCliente/MeusContratos',
      headers: { authorization: bearer },
    });
    expect((contratos.json() as unknown[]).length).toBeGreaterThan(1);
  });

  it('`token` — a mesma credencial só enxerga o contrato do titular dono do token', async () => {
    const app = await appComEscopo('token');
    const bearer = await bearerDe(app);
    const proprio = await app.inject({
      method: 'GET',
      url: `/api/PainelDoCliente/FinanceiroContrato?idContrato=${CONTRATO_DEMO_EM_DIA}&paginaAtual=1`,
      headers: { authorization: bearer },
    });
    expect((proprio.json() as { QtdParcelasTotal: number }).QtdParcelasTotal).toBeGreaterThan(0);

    const alheio = await app.inject({
      method: 'GET',
      url: `/api/PainelDoCliente/FinanceiroContrato?idContrato=${CONTRATO_DEMO_INADIMPLENTE}&paginaAtual=1`,
      headers: { authorization: bearer },
    });
    // mesma forma, zero linhas: é assim que o adapter vai "ver" o problema
    expect((alheio.json() as { QtdParcelasTotal: number }).QtdParcelasTotal).toBe(0);

    const contratos = await app.inject({
      method: 'GET',
      url: '/api/PainelDoCliente/MeusContratos',
      headers: { authorization: bearer },
    });
    expect(contratos.json()).toHaveLength(1);
  });

  it('`obtercontratos` por CPF ignora o escopo — é a saída se a D10 vier ruim', async () => {
    const app = await appComEscopo('token');
    const bearer = await bearerDe(app);
    const { rows } = await admin.query<{ cpf: string }>(
      'SELECT cpf FROM pessoa WHERE idpessoa = (SELECT idpessoatitular FROM contrato WHERE idcontrato = $1)',
      [CONTRATO_DEMO_INADIMPLENTE],
    );
    const r = await app.inject({
      method: 'GET',
      url: `/api/utilizacaocontrato/obtercontratos?cpf=${encodeURIComponent(rows[0]?.cpf ?? '')}`,
      headers: { authorization: bearer },
    });
    expect((r.json() as { IdContrato: number }[])[0]?.IdContrato).toBe(CONTRATO_DEMO_INADIMPLENTE);
  });
});

/**
 * 040 — a 2ª via em PDF, e o que a coleção do fornecedor NÃO diz sobre ela.
 *
 * A coleção só tem o caso feliz (200, `application/pdf`). Erro não tem exemplo
 * nenhum, então o dublê escolheu 404 no envelope do ASP.NET para os três casos
 * em que não existe arquivo — e registra a escolha aqui, para quem for ligar no
 * TSE real (041) saber que este é um ponto a confirmar, não um comportamento
 * observado.
 */
describe('040: a 2ª via em PDF', () => {
  async function idComBoleto(): Promise<number> {
    const { rows } = await admin.query<{ idcontafinanceira: number }>(
      `SELECT idcontafinanceira FROM contafinanceira
        WHERE idcontrato = $1 AND linhadigitavel IS NOT NULL
        ORDER BY idcontafinanceira LIMIT 1`,
      [CONTRATO_DEMO_INADIMPLENTE],
    );
    return rows[0]?.idcontafinanceira ?? 0;
  }

  it('devolve PDF de verdade, com o content-type do fornecedor', async () => {
    const app = await appComEscopo('qualquer');
    const r = await app.inject({
      method: 'GET',
      url: `/api/PainelDoCliente/SegundaViaBoleto/${await idComBoleto()}`,
      headers: { authorization: await bearerDe(app) },
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('application/pdf');
    expect(r.rawPayload.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(r.rawPayload.length).toBeGreaterThan(500);
  });

  it('o papel diz que é simulado — e traz o valor e o vencimento da parcela', async () => {
    const app = await appComEscopo('qualquer');
    const id = await idComBoleto();
    const r = await app.inject({
      method: 'GET',
      url: `/api/PainelDoCliente/SegundaViaBoleto/${id}`,
      headers: { authorization: await bearerDe(app) },
    });
    const papel = r.rawPayload.toString('latin1');
    expect(papel).toContain('DOCUMENTO SIMULADO');
    expect(papel).toContain(String(CONTRATO_DEMO_INADIMPLENTE));
  });

  it('parcela SEM boleto responde 404 — divergência consciente, a coleção não tem o caso', async () => {
    const app = await appComEscopo('qualquer');
    const { rows } = await admin.query<{ idcontafinanceira: number }>(
      `SELECT idcontafinanceira FROM contafinanceira
        WHERE linhadigitavel IS NULL ORDER BY idcontafinanceira LIMIT 1`,
    );
    const r = await app.inject({
      method: 'GET',
      url: `/api/PainelDoCliente/SegundaViaBoleto/${rows[0]?.idcontafinanceira ?? 0}`,
      headers: { authorization: await bearerDe(app) },
    });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toMatchObject({ Message: expect.stringMatching(/boleto/i) });
  });

  it('parcela inexistente responde 404, não 500', async () => {
    const app = await appComEscopo('qualquer');
    const r = await app.inject({
      method: 'GET',
      url: '/api/PainelDoCliente/SegundaViaBoleto/99999999',
      headers: { authorization: await bearerDe(app) },
    });
    expect(r.statusCode).toBe(404);
  });

  it('no escopo `token`, o boleto de outro contrato não sai — a D10 também vale aqui', async () => {
    const app = await appComEscopo('token');
    const r = await app.inject({
      method: 'GET',
      url: `/api/PainelDoCliente/SegundaViaBoleto/${await idComBoleto()}`,
      headers: { authorization: await bearerDe(app) },
    });
    expect(r.statusCode).toBe(404);
  });

  it('sem bearer não há boleto', async () => {
    const app = await appComEscopo('qualquer');
    const r = await app.inject({
      method: 'GET',
      url: `/api/PainelDoCliente/SegundaViaBoleto/${await idComBoleto()}`,
    });
    expect(r.statusCode).toBe(401);
  });
});
