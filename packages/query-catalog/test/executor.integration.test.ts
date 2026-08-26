import { join } from 'node:path';
import { createPgConnector, type DbConnector } from '@seta/erp-connector';
import {
  createExecutor,
  type Executor,
  loadCatalog,
  type QueryEvent,
  type SessionCtx,
} from '@seta/query-catalog';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminUrl, applySchema, seedData } from '../../../infra/erp-mock/seed.ts';

/**
 * Critério 003: fixture de cada entrada inicial rodando contra o seed da 002.
 * Exige o Postgres dev de pé (docker compose -f infra/compose.dev.yml up -d).
 */

const ERP_RO_URL =
  process.env.ERP_DATABASE_URL ?? 'postgres://erp_ro:erp_ro_dev@localhost:5432/erp_mock';

const catalog = loadCatalog(join(import.meta.dirname, '../../../catalog'));
const eventos: QueryEvent[] = [];

let admin: pg.Pool;
let connector: DbConnector;
let executor: Executor;
let pedidoDoCliente1: string;

const SESSION: SessionCtx = {
  traceId: '01890a5d-ac96-774b-bcce-b302099a8057',
  clienteId: '1',
};

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
  await seedData(admin);
  const r = await admin.query({
    text: 'SELECT numped FROM pcpedido WHERE codcli = $1 ORDER BY numped LIMIT 1',
    values: [1],
  });
  pedidoDoCliente1 = String((r.rows[0] as { numped: number }).numped);
  connector = createPgConnector({ url: ERP_RO_URL, poolMax: 3 });
  executor = createExecutor({
    catalog,
    connector,
    sink: {
      async record(e) {
        eventos.push(e);
      },
    },
  });
}, 60_000);

afterAll(async () => {
  await connector?.close();
  await admin?.end();
});

describe('entradas iniciais contra o seed da 002', () => {
  it('cliente.perfil: 1 linha, CNPJ mascarado', async () => {
    const r = await executor.run('cliente.perfil', {}, SESSION);
    expect(r.rowCount).toBe(1);
    expect(r.rows[0]?.razao_social).toBe('Comercial Andrade de Bebidas Ltda');
    expect(r.rows[0]?.documento).toMatch(/^\*\*\.\*\*\*\.\*\*\*\/\*\*\*\*-\d{2}$/);
  });

  it('financeiro.titulos_abertos: só aberto|vencido, ordenado por vencimento', async () => {
    const r = await executor.run('financeiro.titulos_abertos', {}, SESSION);
    expect(r.rowCount).toBeGreaterThan(0);
    const status = new Set(r.rows.map((x) => x.status));
    expect([...status].every((s) => s === 'aberto' || s === 'vencido')).toBe(true);
    const vencimentos = r.rows.map((x) => new Date(x.vencimento as string).getTime());
    expect([...vencimentos].sort((a, b) => a - b)).toEqual(vencimentos);
  });

  it('vendas.ultimos_pedidos: respeita default de quantidade e exclui cancelados', async () => {
    const r = await executor.run('vendas.ultimos_pedidos', {}, SESSION);
    expect(r.rowCount).toBeGreaterThan(0);
    expect(r.rowCount).toBeLessThanOrEqual(5);
    expect(r.rows.every((x) => x.status !== 'cancelado')).toBe(true);
  });

  it('vendas.status_pedido: acha pedido do cliente da sessão', async () => {
    const r = await executor.run('vendas.status_pedido', { pedido_id: pedidoDoCliente1 }, SESSION);
    expect(r.rowCount).toBe(1);
    expect(r.rows[0]?.id).toBe(pedidoDoCliente1);
  });

  it('critério 003: pedido de OUTRO cliente + cliente_id forjado → nada vaza', async () => {
    const outro = await admin.query({
      text: 'SELECT numped, codcli FROM pcpedido WHERE codcli <> $1 LIMIT 1',
      values: [1],
    });
    const { numped, codcli } = outro.rows[0] as { numped: number; codcli: number };
    // o "modelo" tenta forjar cliente_id do dono do pedido — executor usa a sessão
    const r = await executor.run(
      'vendas.status_pedido',
      { pedido_id: String(numped), cliente_id: String(codcli) },
      SESSION,
    );
    expect(r.rowCount).toBe(0);
  });

  it('estoque.disponibilidade: busca parcial por nome', async () => {
    const r = await executor.run('estoque.disponibilidade', { termo: 'pilsen' }, SESSION);
    expect(r.rowCount).toBeGreaterThan(0);
    expect(r.rows.every((x) => String(x.produto).toLowerCase().includes('pilsen'))).toBe(true);
  });

  it('preco.tabela_vigente: preço em centavos com vigência', async () => {
    const r = await executor.run('preco.tabela_vigente', { termo: 'energético' }, SESSION);
    expect(r.rowCount).toBeGreaterThan(0);
    expect(typeof r.rows[0]?.preco_centavos).toBe('string'); // bigint vem como string do pg
    expect(Number(r.rows[0]?.preco_centavos)).toBeGreaterThan(0);
  });

  it('todas as execuções geraram evento_query ok com latência', () => {
    expect(eventos.length).toBeGreaterThanOrEqual(7);
    expect(eventos.every((e) => e.ok && e.latencyMs >= 0)).toBe(true);
  });
});
