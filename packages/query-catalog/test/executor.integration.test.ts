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
import {
  adminUrl,
  applySchema,
  CONTRATO_DEMO_DISTRATO,
  CONTRATO_DEMO_EM_DIA,
  CONTRATO_DEMO_INADIMPLENTE,
  seedData,
} from '../../../infra/erp-mock/seed.ts';

/**
 * Critérios 003/012: as 8 entradas do catálogo rodando contra o seed da 012.
 * Exige o Postgres dev de pé (docker compose -f infra/compose.dev.yml up -d).
 */

const ERP_RO_URL =
  process.env.ERP_DATABASE_URL ?? 'postgres://erp_ro:erp_ro_dev@localhost:5432/erp_mock';

const catalog = loadCatalog(join(import.meta.dirname, '../../../catalog'));
const eventos: QueryEvent[] = [];

let admin: pg.Pool;
let connector: DbConnector;
let executor: Executor;

// sessão do contrato demo ATIVO e EM DIA (10001)
const SESSION: SessionCtx = {
  traceId: '01890a5d-ac96-774b-bcce-b302099a8057',
  clienteId: String(CONTRATO_DEMO_EM_DIA),
};
const SESSION_INADIMPLENTE: SessionCtx = {
  traceId: '01890a5d-ac96-774b-bcce-b302099a8058',
  clienteId: String(CONTRATO_DEMO_INADIMPLENTE),
};
const SESSION_DISTRATO: SessionCtx = {
  traceId: '01890a5d-ac96-774b-bcce-b302099a8059',
  clienteId: String(CONTRATO_DEMO_DISTRATO),
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

describe('as 8 entradas da 012 contra o seed', () => {
  it('financeiro.saldo_contrato: parcelas em aberto e saldo devedor do contrato da sessão', async () => {
    const r = await executor.run('financeiro.saldo_contrato', {}, SESSION);
    expect(r.rowCount).toBe(1);
    expect(Number(r.rows[0]?.parcelas_em_aberto)).toBeGreaterThan(0);
    expect(Number(r.rows[0]?.saldo_devedor_centavos)).toBeGreaterThan(0);
    expect(r.rows[0]?.proximo_vencimento).toBeTruthy();
  });

  it('financeiro.titulos_atraso: contrato em dia devolve vazio; inadimplente lista as vencidas', async () => {
    const emDia = await executor.run('financeiro.titulos_atraso', {}, SESSION);
    expect(emDia.rowCount).toBe(0);

    const r = await executor.run('financeiro.titulos_atraso', {}, SESSION_INADIMPLENTE);
    expect(r.rowCount).toBeGreaterThanOrEqual(3);
    const vencimentos = r.rows.map((x) => new Date(x.vencimento as string).getTime());
    expect([...vencimentos].sort((a, b) => a - b)).toEqual(vencimentos);
    // resumo da inadimplência acompanha cada linha
    expect(Number(r.rows[0]?.qtd_titulos_vencidos)).toBe(r.rowCount);
    expect(Number(r.rows[0]?.maior_atraso_dias)).toBeGreaterThan(0);
  });

  it('financeiro.proxima_parcela: 1 parcela a vencer com meio de pagamento e código de cobrança', async () => {
    const r = await executor.run('financeiro.proxima_parcela', {}, SESSION);
    expect(r.rowCount).toBe(1);
    expect(new Date(r.rows[0]?.vencimento as string).getTime()).toBeGreaterThan(Date.now());
    expect(r.rows[0]?.meio_pagamento).toBe('boleto'); // fixado no seed p/ a demo
    expect(String(r.rows[0]?.linha_digitavel)).toMatch(/^\d{47}$/);
    expect(String(r.rows[0]?.pix_copia_cola)).toContain('br.gov.bcb.pix');
  });

  it('financeiro.total_pago: quebra por origem (entrada + saldo)', async () => {
    const r = await executor.run('financeiro.total_pago', {}, SESSION);
    expect(r.rows.map((x) => x.origem).sort()).toEqual(['entrada', 'saldo']);
    for (const linha of r.rows) {
      expect(Number(linha.parcelas_pagas)).toBeGreaterThan(0);
      expect(Number(linha.total_pago_centavos)).toBeGreaterThan(0);
    }
  });

  it('contrato.minha_cota: bloco, andar, UH e capacidade (fallback de cota do 10001)', async () => {
    const r = await executor.run('contrato.minha_cota', {}, SESSION);
    expect(r.rowCount).toBe(1);
    expect(r.rows[0]?.bloco).toBe('TORRE 2');
    expect(Number(r.rows[0]?.capacidade)).toBeGreaterThan(0);
  });

  it('contrato.meu_produto: tier, períodos e pontos', async () => {
    const r = await executor.run('contrato.meu_produto', {}, SESSION);
    expect(r.rowCount).toBe(1);
    expect(r.rows[0]?.tier).toBe('DIAMANTE PREMIUM');
    expect(r.rows[0]?.periodos).toBe(2);
    expect(Number(r.rows[0]?.pontos)).toBeGreaterThan(0);
    expect(r.rows[0]?.status).toBe('ativo');
  });

  it('contrato.status_cancelamento: distrato em análise no demo; vazio no contrato sem pedido', async () => {
    const semPedido = await executor.run('contrato.status_cancelamento', {}, SESSION);
    expect(semPedido.rowCount).toBe(0);

    const r = await executor.run('contrato.status_cancelamento', {}, SESSION_DISTRATO);
    expect(r.rowCount).toBe(1);
    expect(r.rows[0]?.status).toBe('em_analise');
    expect(Number(r.rows[0]?.multa_centavos)).toBe(850_000);
    expect(Number(r.rows[0]?.reembolso_centavos)).toBe(1_275_000);
  });

  it('atendimento.meu_chamado: ocorrências do titular, mais recente primeiro', async () => {
    const r = await executor.run('atendimento.meu_chamado', {}, SESSION_INADIMPLENTE);
    expect(r.rowCount).toBeGreaterThanOrEqual(1);
    const aberturas = r.rows.map((x) => new Date(x.abertura as string).getTime());
    expect([...aberturas].sort((a, b) => b - a)).toEqual(aberturas);
  });

  it('critério 003/012: contrato_id forjado pelo modelo NÃO vaza dado de outro contrato', async () => {
    // o "modelo" tenta espiar o distrato do 10003 numa sessão do 10001
    const r = await executor.run(
      'contrato.status_cancelamento',
      { contrato_id: String(CONTRATO_DEMO_DISTRATO) },
      SESSION,
    );
    expect(r.rowCount).toBe(0); // executor usou a sessão; 10001 não tem distrato
  });

  it('todas as execuções geraram evento_query ok com latência', () => {
    expect(eventos.length).toBeGreaterThanOrEqual(10);
    expect(eventos.every((e) => e.ok && e.latencyMs >= 0)).toBe(true);
  });
});
