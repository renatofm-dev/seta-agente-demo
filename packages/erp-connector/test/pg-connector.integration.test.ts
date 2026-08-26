import { createPgConnector, type DbConnector, QueryTimeoutError } from '@seta/erp-connector';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminUrl, applySchema, seedData } from '../../../infra/erp-mock/seed.ts';

/**
 * Testes de integração da spec 002 — exigem o Postgres dev de pé
 * (docker compose -f infra/compose.dev.yml up -d). Critérios:
 * timeout, maxRows/truncated, permissões do erp_ro e idempotência do seed.
 */

const ERP_RO_URL =
  process.env.ERP_DATABASE_URL ?? 'postgres://erp_ro:erp_ro_dev@localhost:5432/erp_mock';

let admin: pg.Pool;
let connector: DbConnector;

beforeAll(async () => {
  admin = new pg.Pool({ connectionString: adminUrl(), max: 2 });
  try {
    await admin.query('SELECT 1');
  } catch (err) {
    throw new Error(
      'Postgres dev indisponível — suba com: docker compose -f infra/compose.dev.yml up -d --wait',
      { cause: err },
    );
  }
  await applySchema(admin);
  connector = createPgConnector({ url: ERP_RO_URL, poolMax: 3 });
}, 30_000);

afterAll(async () => {
  await connector?.close();
  await admin?.end();
});

describe('erp-connector pg (integração)', () => {
  it('execute respeita timeoutMs via statement_timeout (pg_sleep)', async () => {
    await expect(
      connector.execute(
        { sql: 'SELECT pg_sleep(:segundos)', binds: { segundos: 2 } },
        { timeoutMs: 150 },
      ),
    ).rejects.toThrow(QueryTimeoutError);
  });

  it('execute corta em maxRows e sinaliza truncated', async () => {
    const cortado = await connector.execute(
      { sql: 'SELECT g AS n FROM generate_series(1, :total) g', binds: { total: 100 } },
      { maxRows: 10 },
    );
    expect(cortado.rows).toHaveLength(10);
    expect(cortado.rowCount).toBe(10);
    expect(cortado.truncated).toBe(true);

    const completo = await connector.execute(
      { sql: 'SELECT g AS n FROM generate_series(1, :total) g', binds: { total: 5 } },
      { maxRows: 10 },
    );
    expect(completo.rows).toHaveLength(5);
    expect(completo.truncated).toBe(false);
    expect(completo.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('health responde ok com latência', async () => {
    const h = await connector.health();
    expect(h.ok).toBe(true);
    expect(h.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

describe('fronteira erp_ro (integração)', () => {
  it('lê views canônicas', async () => {
    const r = await connector.execute({ sql: 'SELECT id FROM v_cliente', binds: {} }, {});
    expect(r.rows.length).toBeGreaterThan(0);
  });

  it('NÃO lê tabela física (permission denied)', async () => {
    await expect(
      connector.execute({ sql: 'SELECT * FROM pcclient', binds: {} }, {}),
    ).rejects.toThrow(/permission denied/);
  });

  it('NÃO escreve em nada — nem via cliente pg direto', async () => {
    const cliente = new pg.Client({ connectionString: ERP_RO_URL });
    await cliente.connect();
    try {
      await expect(
        cliente.query(
          "INSERT INTO pcclient (codcli, cgcent, cliente, dtcad) VALUES (999, 'x', 'x', current_date)",
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(cliente.query('DELETE FROM pcprest')).rejects.toThrow(/permission denied/);
      await expect(cliente.query("UPDATE pcpedido SET posicao = 'C'")).rejects.toThrow(
        /permission denied/,
      );
    } finally {
      await cliente.end();
    }
  });
});

describe('seed erp_mock (integração)', () => {
  it('rodar 2x não duplica (contagens estáveis)', async () => {
    const resumo1 = await seedData(admin);
    const resumo2 = await seedData(admin);
    expect(resumo1.clientes).toBe(20);
    expect(resumo1.produtos).toBe(40);
    expect(resumo1.pedidos).toBe(500);

    const contar = async (tabela: string) => {
      // tabela vem de lista fixa do teste, não de input externo
      const r = await admin.query(`SELECT count(*)::int AS n FROM ${tabela}`);
      return (r.rows[0] as { n: number }).n;
    };
    expect(await contar('pcclient')).toBe(resumo2.clientes);
    expect(await contar('pcpedido')).toBe(resumo2.pedidos);
    expect(await contar('pcpediitem')).toBe(resumo2.itens);
    expect(await contar('pcprest')).toBe(resumo2.titulos);
    expect(await contar('pcest')).toBe(40);
    expect(await contar('pctabpreco')).toBe(40);
  }, 60_000);

  it('títulos são coerentes com os pedidos (soma das parcelas = total do pedido)', async () => {
    const r = await admin.query(`
      SELECT count(*)::int AS incoerentes FROM (
        SELECT t.numped
        FROM pcprest t
        JOIN pcpedido p ON p.numped = t.numped
        GROUP BY t.numped, p.vltotal
        HAVING abs(sum(t.valor) - p.vltotal) > 0.01
      ) q
    `);
    expect((r.rows[0] as { incoerentes: number }).incoerentes).toBe(0);
  });

  it('views canônicas expõem os dados com status traduzido', async () => {
    const titulos = await connector.execute(
      {
        sql: "SELECT status, count(*)::int AS n FROM v_titulo WHERE status IN ('aberto', 'vencido', 'pago') GROUP BY status",
        binds: {},
      },
      {},
    );
    expect(titulos.rows.length).toBe(3); // os três status ocorrem no seed

    const precos = await connector.execute(
      { sql: 'SELECT count(*)::int AS n FROM v_tabela_preco', binds: {} },
      {},
    );
    expect((precos.rows[0] as { n: number }).n).toBe(40); // vigência cobre todos os SKUs
  });
});
