import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminUrl,
  applySchema,
  CONTRATO_DEMO_INADIMPLENTE,
  seedData,
} from '../../../infra/erp-mock/seed.ts';
import type { App } from '../src/app.ts';
import { buildTseSimApp } from '../src/app.ts';
import { type Banco, criarBanco } from '../src/db.ts';
import { loadEnv } from '../src/env.ts';

/**
 * A prova de que o simulador ESCREVE — e de que a escrita é a MESMA VERDADE que
 * o produto lê. `TransacaoEletronica` grava `contafinanceira.datarecebimento`, e
 * `v_titulo` (a view que o catálogo consulta, por `erp_ro`) passa a `pago` na
 * leitura seguinte. É isso que mata a conciliação fingida da 014 na 036: não há
 * sincronização, é a mesma linha da mesma tabela.
 *
 * Exige o Postgres dev de pé (docker compose -f infra/compose.dev.yml up -d).
 */

const env = loadEnv({
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  TSE_SIM_DATABASE_URL:
    process.env.TSE_SIM_DATABASE_URL ?? 'postgres://tse_sim:tse_sim_dev@localhost:5432/erp_mock',
});
const ERP_RO_URL =
  process.env.ERP_DATABASE_URL ?? 'postgres://erp_ro:erp_ro_dev@localhost:5432/erp_mock';

let admin: pg.Pool;
let leitor: pg.Pool;
let db: Banco;
let app: App;
let bearer: string;

async function autenticar(): Promise<string> {
  const r = await app.inject({
    method: 'POST',
    url: '/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'grant_type=password&username=integracao&password=integracao',
  });
  return `Bearer ${(r.json() as { access_token: string }).access_token}`;
}

/** Primeira parcela em aberto do contrato inadimplente da demo. */
async function parcelaAberta(): Promise<number> {
  const { rows } = await admin.query<{ idcontafinanceira: number }>(
    `SELECT idcontafinanceira FROM contafinanceira
      WHERE idcontrato = $1 AND datarecebimento IS NULL
      ORDER BY idcontafinanceira LIMIT 1`,
    [CONTRATO_DEMO_INADIMPLENTE],
  );
  return rows[0]?.idcontafinanceira as number;
}

async function statusNoProduto(id: number): Promise<string | undefined> {
  const { rows } = await leitor.query<{ status: string }>(
    'SELECT status FROM v_titulo WHERE id = $1',
    [String(id)],
  );
  return rows[0]?.status;
}

beforeAll(async () => {
  admin = new pg.Pool({ connectionString: adminUrl(), max: 2 });
  leitor = new pg.Pool({ connectionString: ERP_RO_URL, max: 2 });
  await applySchema(admin);
  await seedData(admin);
  db = criarBanco(env.TSE_SIM_DATABASE_URL);
  app = buildTseSimApp({ env, db });
  await app.ready();
  bearer = await autenticar();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.fechar();
  await leitor?.end();
  if (admin) await seedData(admin);
  await admin?.end();
}, 120_000);

describe('escrita: a baixa do TSE é a mesma linha que o produto lê', () => {
  it('TransacaoEletronica faz v_titulo virar `pago` — sem camada de conciliação no meio', async () => {
    const id = await parcelaAberta();
    expect(await statusNoProduto(id)).not.toBe('pago');

    const resposta = await app.inject({
      method: 'POST',
      url: '/api/financeiro/TransacaoEletronica',
      headers: { authorization: bearer },
      payload: { IdContaFinanceira: id, Valor: 123.45, QuantidadeParcelas: 1 },
    });
    expect(resposta.statusCode).toBe(200);
    expect(resposta.json()).toMatch(/^Transação inserida com sucesso, sob id: \d+$/);

    expect(await statusNoProduto(id)).toBe('pago');
    const { rows } = await leitor.query<{ valor_pago_centavos: string }>(
      'SELECT valor_pago_centavos FROM v_titulo WHERE id = $1',
      [String(id)],
    );
    expect(Number(rows[0]?.valor_pago_centavos)).toBe(12_345);
  });

  it('a transação fica registrada em tse_sim.transacaoeletronica', async () => {
    const { rows } = await admin.query<{ n: string }>(
      'SELECT count(*) AS n FROM tse_sim.transacaoeletronica',
    );
    expect(Number(rows[0]?.n)).toBeGreaterThan(0);
  });

  it('parcela inexistente não vira baixa fantasma', async () => {
    const resposta = await app.inject({
      method: 'POST',
      url: '/api/financeiro/TransacaoEletronica',
      headers: { authorization: bearer },
      payload: { IdContaFinanceira: 99_999_999, Valor: 1 },
    });
    expect(resposta.statusCode).toBe(400);
  });
});

describe('escrita: o INSERT sem id funciona DEPOIS de um seed com id explícito', () => {
  /**
   * O defeito que este teste existe para pegar: `seedData` insere ids na mão e
   * deixaria as sequências para trás; o primeiro INSERT do simulador colidiria
   * com a PK. Rodar a carga DUAS VEZES e inserir depois de cada uma é a prova
   * de que `ressincronizar_sequences()` está no lugar certo.
   */
  it('cria parcelas pela API duas vezes seguidas, com um seed no meio', async () => {
    for (const rodada of [1, 2]) {
      const resposta = await app.inject({
        method: 'POST',
        url: '/api/financeiro/ContaFinanceira',
        headers: { authorization: bearer },
        payload: {
          IdContrato: CONTRATO_DEMO_INADIMPLENTE,
          IdTipoOrigemContaFinanceira: 2,
          IdMeioPagamento: 1,
          DataVencimento: '2026-12-10',
          ValorReceber: 8,
          QuantidadeParcelas: 2,
        },
      });
      expect(resposta.statusCode, `rodada ${rodada}: ${resposta.body}`).toBe(200);
      const ids = (resposta.json() as string).replace('Contas financeiras criadas sob ids: ', '');
      expect(ids.split(', ')).toHaveLength(2);
      if (rodada === 1) await seedData(admin);
    }
  }, 120_000);

  it('PUT altera a parcela e o valor novo chega ao produto', async () => {
    const id = await parcelaAberta();
    const resposta = await app.inject({
      method: 'PUT',
      url: `/api/financeiro/ContaFinanceira/${id}`,
      headers: { authorization: bearer },
      payload: { ValorReceber: 77 },
    });
    expect(resposta.statusCode).toBe(200);
    expect(resposta.json()).toBe('Conta financeira alterada.');
    const { rows } = await leitor.query<{ valor_centavos: string }>(
      'SELECT valor_centavos FROM v_titulo WHERE id = $1',
      [String(id)],
    );
    expect(Number(rows[0]?.valor_centavos)).toBe(7_700);
  });

  /**
   * Regressão de um defeito real: com `ContaFinanceiraSchema.partial()`, o
   * `.default()` do Zod continuava valendo e um PUT que não citava
   * `IdMeioPagamento` reescrevia a parcela para BOLETO sem dizer nada.
   */
  it('PUT que não cita um campo NÃO o reescreve (meio de pagamento intacto)', async () => {
    const { rows: alvo } = await admin.query<{
      idcontafinanceira: number;
      idmeiopagamento: number;
    }>(
      `SELECT idcontafinanceira, idmeiopagamento FROM contafinanceira
        WHERE idmeiopagamento <> 1 ORDER BY idcontafinanceira LIMIT 1`,
    );
    const id = alvo[0]?.idcontafinanceira as number;
    const meioAntes = alvo[0]?.idmeiopagamento;

    const resposta = await app.inject({
      method: 'PUT',
      url: `/api/financeiro/ContaFinanceira/${id}`,
      headers: { authorization: bearer },
      payload: { ValorReceber: 55 },
    });
    expect(resposta.statusCode).toBe(200);

    const { rows } = await admin.query<{ idmeiopagamento: number }>(
      'SELECT idmeiopagamento FROM contafinanceira WHERE idcontafinanceira = $1',
      [id],
    );
    expect(rows[0]?.idmeiopagamento).toBe(meioAntes);
  });
});

describe('escrita: a fronteira dos papéis continua de pé', () => {
  it('o simulador escreve na tabela física e continua CEGO para as views', async () => {
    await expect(db.buscar('SELECT 1 FROM v_titulo LIMIT 1')).rejects.toThrow(/permission denied/i);
  });

  it('o produto (erp_ro) não enxerga o que é do simulador', async () => {
    await expect(leitor.query('SELECT 1 FROM tse_sim.transacaoeletronica')).rejects.toThrow(
      /permission denied|does not exist/i,
    );
  });
});
