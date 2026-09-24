import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminUrl,
  applySchema,
  CONTRATO_DEMO_EM_DIA,
  seedData,
} from '../../../infra/erp-mock/seed.ts';
import type { App } from '../src/app.ts';
import { buildTseSimApp } from '../src/app.ts';
import { type Banco, criarBanco } from '../src/db.ts';
import { loadEnv } from '../src/env.ts';

/**
 * 046 — o documento do contrato, servido pelo simulador sob `/sim/`.
 *
 * Diferente do resto do `tse-sim`, esta rota **não tem original na coleção**:
 * a API do TSE não expõe documento de contrato. Ela existe porque a 046 precisa
 * de um papel para assinar, e o prefixo `/sim/` é o que impede alguém de tomar
 * a invenção por contrato do fornecedor.
 *
 * Exige o Postgres dev de pé (docker compose -f infra/compose.dev.yml up -d).
 */

const BASE = {
  NODE_ENV: 'test' as const,
  LOG_LEVEL: 'silent' as const,
  TSE_SIM_DATABASE_URL:
    process.env.TSE_SIM_DATABASE_URL ?? 'postgres://tse_sim:tse_sim_dev@localhost:5432/erp_mock',
  TSE_SIM_USERS: 'integracao:integracao:1',
};

let admin: pg.Pool;
let db: Banco;
let app: App;
let bearer: string;

beforeAll(async () => {
  admin = new pg.Pool({ connectionString: adminUrl(), max: 2 });
  await applySchema(admin);
  await seedData(admin);
  db = criarBanco(BASE.TSE_SIM_DATABASE_URL);
  app = buildTseSimApp({ env: loadEnv(BASE), db });
  await app.ready();
  const r = await app.inject({
    method: 'POST',
    url: '/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'grant_type=password&username=integracao&password=integracao',
  });
  bearer = `Bearer ${(r.json() as { access_token: string }).access_token}`;
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.fechar();
  await admin?.end();
});

const pedir = (id: string | number, headers: Record<string, string> = { authorization: bearer }) =>
  app.inject({ method: 'GET', url: `/sim/contratos/${id}/documento.pdf`, headers });

describe('046: o contrato em PDF', () => {
  it('devolve application/pdf com o que a venda gravou', async () => {
    const r = await pedir(CONTRATO_DEMO_EM_DIA);

    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('application/pdf');
    const pdf = r.rawPayload;
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');

    const textos = [...pdf.toString('latin1').matchAll(/\((.*?)\) Tj/g)].map((m) => m[1] ?? '');
    expect(textos.some((t) => t.includes(`Contrato nº ${CONTRATO_DEMO_EM_DIA}`))).toBe(true);
    // o plano de pagamento vem AGRUPADO: o contrato do seed tem 124 parcelas
    expect(textos.some((t) => /^\d+x R\$ /.test(t))).toBe(true);
    expect(textos.filter((t) => /^\d{2}\/\d{2}\/\d{4}$/.test(t)).length).toBeLessThan(5);
  });

  it('contrato inexistente é 404 de negócio, não 500', async () => {
    const r = await pedir(999_999);

    expect(r.statusCode).toBe(404);
    expect((r.json() as { Message: string }).Message).toMatch(/nao encontrado/i);
  });

  it('sem bearer não sai documento — é dado pessoal do cotista', async () => {
    const r = await pedir(CONTRATO_DEMO_EM_DIA, {});

    expect(r.statusCode).toBe(401);
  });
});
