import { join } from 'node:path';
import type { DbConnector } from '@seta/erp-connector';
import {
  buildToolSpecs,
  createExecutor,
  loadCatalog,
  type QueryEvent,
  type SessionCtx,
} from '@seta/query-catalog';
import { describe, expect, it } from 'vitest';

const catalog = loadCatalog(join(import.meta.dirname, '../../../catalog'));

const SESSION: SessionCtx = {
  traceId: '01890a5d-ac96-774b-bcce-b302099a8057',
  clienteId: '7',
};

function fakes(rows: Record<string, unknown>[] = [{ id: '1' }]) {
  const chamadas: { sql: string; binds: Record<string, unknown>; opts: unknown }[] = [];
  const eventos: QueryEvent[] = [];
  const avisos: Record<string, unknown>[] = [];
  const connector: DbConnector = {
    dialect: 'postgres',
    async execute(q, o) {
      chamadas.push({ sql: q.sql, binds: q.binds, opts: o });
      return { rows, rowCount: rows.length, truncated: false, latencyMs: 7 };
    },
    async health() {
      return { ok: true, latencyMs: 1 };
    },
    async close() {},
  };
  const executor = createExecutor({
    catalog,
    connector,
    sink: {
      async record(e) {
        eventos.push(e);
      },
    },
    logger: {
      info: () => {},
      warn: (obj) => {
        avisos.push(obj);
      },
    },
  });
  return { executor, chamadas, eventos, avisos };
}

describe('executor do catálogo', () => {
  it('critério 003: cliente_id forjado pelo modelo é IGNORADO — vale o da sessão (e loga)', async () => {
    const { executor, chamadas, avisos } = fakes();
    await executor.run('financeiro.titulos_abertos', { cliente_id: '999' }, SESSION);
    expect(chamadas[0]?.binds).toEqual({ cliente_id: '7' }); // sessão, não o forjado
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toMatchObject({ param: 'cliente_id', traceId: SESSION.traceId });
  });

  it('critério 003: masking aplicado antes do retorno e evento_query com latência e linhas', async () => {
    const { executor, eventos } = fakes([
      { id: '7', documento: '12.345.678/0001-95', razao_social: 'ACME', nome_fantasia: null },
    ]);
    const r = await executor.run('cliente.perfil', {}, SESSION);
    expect(r.rows[0]?.documento).toBe('**.***.***/****-95');
    expect(eventos).toHaveLength(1);
    expect(eventos[0]).toMatchObject({
      entryId: 'cliente.perfil',
      ok: true,
      latencyMs: 7,
      linhas: 1,
      truncated: false,
    });
  });

  it('aplica limits da entrada no connector e default de param agent', async () => {
    const { executor, chamadas } = fakes();
    await executor.run('vendas.ultimos_pedidos', {}, SESSION);
    expect(chamadas[0]?.opts).toEqual({ timeoutMs: 3_000, maxRows: 20 });
    expect(chamadas[0]?.binds).toEqual({ cliente_id: '7', quantidade: 5 }); // default
  });

  it('valida param agent com Zod e exige obrigatório', async () => {
    const { executor } = fakes();
    await expect(executor.run('vendas.status_pedido', {}, SESSION)).rejects.toThrow(
      /obrigatório ausente: "pedido_id"/,
    );
    await expect(
      executor.run('vendas.ultimos_pedidos', { quantidade: 'muitos' }, SESSION),
    ).rejects.toThrow(/param "quantidade" inválido/);
  });

  it('erro do connector gera evento ok=false com a mensagem e propaga', async () => {
    const eventos: QueryEvent[] = [];
    const executor = createExecutor({
      catalog,
      connector: {
        dialect: 'postgres',
        execute: async () => {
          throw new Error('boom');
        },
        health: async () => ({ ok: true, latencyMs: 1 }),
        close: async () => {},
      },
      sink: {
        async record(e) {
          eventos.push(e);
        },
      },
    });
    await expect(executor.run('cliente.perfil', {}, SESSION)).rejects.toThrow('boom');
    expect(eventos[0]).toMatchObject({ ok: false, erro: 'boom', linhas: 0 });
  });
});

describe('codegen de ToolSpecs', () => {
  it('expõe só params source:agent e filtra por módulos habilitados', () => {
    const { executor } = fakes();
    const todas = buildToolSpecs(catalog, executor, {
      modulosHabilitados: { financeiro: true, pedidos: true, suporte: true },
    });
    expect(todas.map((t) => t.name).sort()).toEqual([
      'estoque_disponibilidade',
      'perfil_cliente',
      'preco_tabela_vigente',
      'status_pedido',
      'titulos_abertos',
      'ultimos_pedidos',
    ]);
    const statusPedido = todas.find((t) => t.name === 'status_pedido');
    expect(Object.keys(statusPedido?.schema.shape ?? {})).toEqual(['pedido_id']); // sem cliente_id

    const soFinanceiro = buildToolSpecs(catalog, executor, {
      modulosHabilitados: { financeiro: true, pedidos: false, suporte: false },
    });
    expect(soFinanceiro.map((t) => t.name).sort()).toEqual(['perfil_cliente', 'titulos_abertos']);
    expect(soFinanceiro.find((t) => t.name === 'preco_tabela_vigente')).toBeUndefined();
  });

  it('tool sem vínculo na sessão recusa executar', async () => {
    const { executor } = fakes();
    const [tool] = buildToolSpecs(catalog, executor, {
      modulosHabilitados: { financeiro: true, pedidos: true, suporte: true },
    });
    await expect(
      tool?.execute({}, { traceId: SESSION.traceId, clienteId: '' }) as Promise<unknown>,
    ).rejects.toThrow(/sem vínculo/);
  });
});
