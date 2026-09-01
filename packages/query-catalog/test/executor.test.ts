import { join } from 'node:path';
import type { DbConnector } from '@seta/erp-connector';
import {
  buildToolSpecs,
  type CatalogIndex,
  createExecutor,
  loadCatalog,
  type QueryEvent,
  type SessionCtx,
} from '@seta/query-catalog';
import { describe, expect, it } from 'vitest';

const catalog = loadCatalog(join(import.meta.dirname, '../../../catalog'));
// fixtures com params agent e masking (as entradas reais da 012 só têm sessão)
const fixtures = loadCatalog(join(import.meta.dirname, 'fixtures-validas'));

const SESSION: SessionCtx = {
  traceId: '01890a5d-ac96-774b-bcce-b302099a8057',
  clienteId: '10007',
};

const MODULOS = { financeiro: true, contrato: true, atendimento: true };

function fakes(indice: CatalogIndex, rows: Record<string, unknown>[] = [{ id: '1' }]) {
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
    catalog: indice,
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
  it('critério 003/012: contrato_id forjado pelo modelo é IGNORADO — vale o da sessão (e loga)', async () => {
    const { executor, chamadas, avisos } = fakes(catalog);
    await executor.run('financeiro.saldo_contrato', { contrato_id: '999' }, SESSION);
    expect(chamadas[0]?.binds).toEqual({ contrato_id: '10007' }); // sessão, não o forjado
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toMatchObject({ param: 'contrato_id', traceId: SESSION.traceId });
  });

  it('critério 003: masking aplicado antes do retorno e evento_query com latência e linhas', async () => {
    const { executor, eventos } = fakes(fixtures, [{ id: '7', documento: '12.345.678/0001-95' }]);
    const r = await executor.run('financeiro.titulos_filtro', {}, SESSION);
    expect(r.rows[0]?.documento).toBe('**.***.***/****-95');
    expect(eventos).toHaveLength(1);
    expect(eventos[0]).toMatchObject({
      entryId: 'financeiro.titulos_filtro',
      ok: true,
      latencyMs: 7,
      linhas: 1,
      truncated: false,
    });
  });

  it('aplica limits da entrada no connector e default de param agent', async () => {
    const { executor, chamadas } = fakes(fixtures);
    await executor.run('financeiro.titulos_filtro', {}, SESSION);
    expect(chamadas[0]?.opts).toEqual({ timeoutMs: 3_000, maxRows: 20 });
    expect(chamadas[0]?.binds).toEqual({ contrato_id: '10007', quantidade: 5 }); // default
  });

  it('valida param agent com Zod e exige obrigatório', async () => {
    const { executor } = fakes(fixtures);
    await expect(executor.run('atendimento.chamado_por_id', {}, SESSION)).rejects.toThrow(
      /obrigatório ausente: "chamado_id"/,
    );
    await expect(
      executor.run('financeiro.titulos_filtro', { quantidade: 'muitos' }, SESSION),
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
    await expect(executor.run('contrato.minha_cota', {}, SESSION)).rejects.toThrow('boom');
    expect(eventos[0]).toMatchObject({ ok: false, erro: 'boom', linhas: 0 });
  });
});

describe('codegen de ToolSpecs', () => {
  it('expõe só params source:agent e filtra por módulos habilitados', () => {
    const { executor } = fakes(catalog);
    const todas = buildToolSpecs(catalog, executor, { modulosHabilitados: MODULOS });
    expect(todas.map((t) => t.name).sort()).toEqual([
      'meu_chamado',
      'meu_produto',
      'minha_cota',
      'proxima_parcela',
      'saldo_contrato',
      'status_cancelamento',
      'titulos_atraso',
      'total_pago',
    ]);
    // nenhum param de sessão vaza para o schema que o modelo enxerga
    for (const tool of todas) {
      expect(Object.keys(tool.schema.shape)).not.toContain('contrato_id');
    }

    const soFinanceiro = buildToolSpecs(catalog, executor, {
      modulosHabilitados: { financeiro: true, contrato: false, atendimento: false },
    });
    expect(soFinanceiro.map((t) => t.name).sort()).toEqual([
      'proxima_parcela',
      'saldo_contrato',
      'titulos_atraso',
      'total_pago',
    ]);
    expect(soFinanceiro.find((t) => t.name === 'minha_cota')).toBeUndefined();
  });

  it('param source:agent aparece no schema da tool (fixture)', () => {
    const { executor } = fakes(fixtures);
    const tools = buildToolSpecs(fixtures, executor, { modulosHabilitados: MODULOS });
    const porId = tools.find((t) => t.entryId === 'atendimento.chamado_por_id');
    expect(Object.keys(porId?.schema.shape ?? {})).toEqual(['chamado_id']); // sem contrato_id
  });

  it('tool sem vínculo na sessão recusa executar', async () => {
    const { executor } = fakes(catalog);
    const [tool] = buildToolSpecs(catalog, executor, { modulosHabilitados: MODULOS });
    await expect(
      tool?.execute({}, { traceId: SESSION.traceId, clienteId: '' }) as Promise<unknown>,
    ).rejects.toThrow(/sem vínculo/);
  });
});

describe('#37: falha de validação também é auditada', () => {
  it('param inválido do modelo gera evento_query ok:false (antes era invisível)', async () => {
    const { executor, eventos, chamadas } = fakes(fixtures);
    await expect(
      executor.run('financeiro.titulos_filtro', { quantidade: 'não-é-número' }, SESSION),
    ).rejects.toThrow(/inválido/);
    expect(chamadas).toHaveLength(0); // nunca chegou ao banco
    expect(eventos).toHaveLength(1);
    expect(eventos[0]).toMatchObject({ ok: false, entryId: 'financeiro.titulos_filtro' });
    expect(eventos[0]?.erro).toContain('quantidade');
  });
});
