import { CatalogEntryIdSchema, ParamSourceSchema } from '@seta/query-catalog';
import { describe, expect, it } from 'vitest';

describe('query-catalog (port)', () => {
  it('aceita ids kebab-case', () => {
    expect(CatalogEntryIdSchema.safeParse('boletos-em-aberto').success).toBe(true);
    expect(CatalogEntryIdSchema.safeParse('pedidos-recentes').success).toBe(true);
  });

  it('rejeita ids fora do padrão', () => {
    for (const id of ['BoletosAbertos', 'boletos_abertos', '-boletos', 'boletos-', '']) {
      expect(CatalogEntryIdSchema.safeParse(id).success).toBe(false);
    }
  });

  it('origem de parâmetro é restrita a session|llm', () => {
    expect(ParamSourceSchema.safeParse('session').success).toBe(true);
    expect(ParamSourceSchema.safeParse('user').success).toBe(false);
  });
});
