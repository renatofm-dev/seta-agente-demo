import { CatalogEntryIdSchema, CatalogEntrySchema, ParamSourceSchema } from '@seta/query-catalog';
import { describe, expect, it } from 'vitest';

describe('query-catalog (schemas)', () => {
  it('id segue o formato dominio.nome', () => {
    expect(CatalogEntryIdSchema.safeParse('financeiro.titulos_abertos').success).toBe(true);
    expect(CatalogEntryIdSchema.safeParse('cliente.perfil').success).toBe(true);
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
      id: 'vendas.exemplo',
      version: 1,
      description: 'Descrição caprichada o suficiente para o modelo entender o uso.',
      entities: ['pedido'],
      params: {
        cliente_id: { type: 'string', source: 'session' },
      },
      sql: 'SELECT id FROM v_pedido WHERE cliente_id = :cliente_id',
      output: { columns: ['id'] },
      tool: { expose: true, name: 'exemplo' },
    });
    expect(entry.limits).toEqual({ timeout_ms: 3_000, max_rows: 100 });
    expect(entry.output.masking).toEqual({});
    expect(entry.price_source).toBe(false);
    expect(entry.params.cliente_id?.required).toBe(true);
  });

  it('description curta é rejeitada (é o que o modelo lê)', () => {
    expect(
      CatalogEntrySchema.safeParse({
        id: 'a.b',
        version: 1,
        description: 'curta',
        entities: ['x'],
        sql: 'SELECT 1 FROM v_cliente',
        output: { columns: ['c'] },
        tool: { expose: false, name: 'x' },
      }).success,
    ).toBe(false);
  });
});
