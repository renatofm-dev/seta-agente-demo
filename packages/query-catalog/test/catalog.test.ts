import { join } from 'node:path';
import {
  buildToolSpecs,
  CatalogEntryIdSchema,
  CatalogEntrySchema,
  loadCatalog,
  ParamSourceSchema,
} from '@seta/query-catalog';
import { describe, expect, it } from 'vitest';

describe('query-catalog (schemas)', () => {
  it('id segue o formato dominio.nome', () => {
    expect(CatalogEntryIdSchema.safeParse('financeiro.titulos_atraso').success).toBe(true);
    expect(CatalogEntryIdSchema.safeParse('contrato.minha_cota').success).toBe(true);
    for (const id of ['semdominio', 'a.b.c', 'Financeiro.titulos', 'a-b.c', '.perfil', '']) {
      expect(CatalogEntryIdSchema.safeParse(id).success).toBe(false);
    }
  });

  it('origem de parâmetro é restrita a session|agent', () => {
    expect(ParamSourceSchema.safeParse('session').success).toBe(true);
    expect(ParamSourceSchema.safeParse('agent').success).toBe(true);
    expect(ParamSourceSchema.safeParse('llm').success).toBe(false);
  });

  it('entrada completa valida e aplica defaults de limits/masking', () => {
    const entry = CatalogEntrySchema.parse({
      id: 'financeiro.exemplo',
      version: 1,
      description: 'Descrição caprichada o suficiente para o modelo entender o uso.',
      entities: ['titulo'],
      params: {
        contrato_id: { type: 'string', source: 'session' },
      },
      sql: 'SELECT id FROM v_titulo WHERE contrato_id = :contrato_id',
      output: { columns: ['id'] },
      tool: { expose: true, name: 'exemplo' },
    });
    expect(entry.limits).toEqual({ timeout_ms: 3_000, max_rows: 100 });
    expect(entry.output.masking).toEqual({});
    expect(entry.price_source).toBe(false);
    expect(entry.params.contrato_id?.required).toBe(true);
  });

  it('description curta é rejeitada (é o que o modelo lê)', () => {
    expect(
      CatalogEntrySchema.safeParse({
        id: 'a.b',
        version: 1,
        description: 'curta',
        entities: ['x'],
        sql: 'SELECT 1 FROM v_cotista',
        output: { columns: ['c'] },
        tool: { expose: false, name: 'x' },
      }).success,
    ).toBe(false);
  });
});

describe('#35: tools filtradas por vínculo na sessão', () => {
  it('sem vínculo, nenhuma tool de dado é exposta', async () => {
    const catalog = loadCatalog(join(import.meta.dirname, '../../../catalog'));
    const executor = { run: async () => ({ rows: [], rowCount: 0, truncated: false }) };
    const todas = buildToolSpecs(catalog, executor as never, {
      modulosHabilitados: { financeiro: true, contrato: true, atendimento: true },
    });
    expect(todas.length).toBeGreaterThan(0);
    const semVinculo = buildToolSpecs(catalog, executor as never, {
      modulosHabilitados: { financeiro: true, contrato: true, atendimento: true },
      temVinculo: false,
    });
    expect(semVinculo).toEqual([]);
  });

  it('015: o portão é por escopo — sem vínculo, só entradas sem param de vínculo (comercial.*)', async () => {
    const catalog = loadCatalog(join(import.meta.dirname, '../../../catalog'));
    const executor = { run: async () => ({ rows: [], rowCount: 0, truncated: false }) };
    const lead = buildToolSpecs(catalog, executor as never, {
      modulosHabilitados: { financeiro: true, contrato: true, atendimento: true, sdr: true },
      temVinculo: false,
    });
    expect(lead.map((t) => t.name).sort()).toEqual(['condicoes_cota', 'estoque_disponivel']);
    // a tool de condições é a fonte de preço reconhecida pelo guardrail
    expect(lead.find((t) => t.name === 'condicoes_cota')?.priceSource).toBe(true);
    expect(lead.find((t) => t.name === 'estoque_disponivel')?.priceSource).toBe(false);
    // sem vínculo, a tool grão-contrato nem existe; a comercial executa normalmente
    const sessao = { traceId: 't', clienteId: '', descontoMaxBps: 300 };
    await expect(lead[0]?.execute({}, sessao)).resolves.toBeDefined();
    // com vínculo e módulo sdr, as duas famílias convivem
    const cotista = buildToolSpecs(catalog, executor as never, {
      modulosHabilitados: { financeiro: true, contrato: true, atendimento: true, sdr: true },
      temVinculo: true,
    });
    expect(cotista.map((t) => t.name)).toEqual(
      expect.arrayContaining(['minha_cota', 'estoque_disponivel']),
    );
  });
});
