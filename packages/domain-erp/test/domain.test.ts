import {
  CANCELAMENTO_STATUS,
  CONTRATO_STATUS,
  COTA_TIERS,
  type ContratoStatus,
  type Cotista,
  TITULO_STATUS,
  type Titulo,
  type TituloStatus,
} from '@seta/domain-erp';
import { describe, expect, expectTypeOf, it } from 'vitest';

describe('domain-erp (multipropriedade — spec 012)', () => {
  it('status de contrato cobrem o ciclo (ativo absorve ATIVOREV) sem duplicatas', () => {
    expect(CONTRATO_STATUS).toContain('ativo');
    expect(CONTRATO_STATUS).toContain('cancelado');
    expect(new Set(CONTRATO_STATUS).size).toBe(CONTRATO_STATUS.length);
  });

  it('status de título cobrem o ciclo de cobrança sem duplicatas', () => {
    expect(TITULO_STATUS).toContain('vencido');
    expect(new Set(TITULO_STATUS).size).toBe(TITULO_STATUS.length);
  });

  it('tiers são os 6 do grupocota (OURO/DIAMANTE × PREMIUM/MASTER/SPECIAL)', () => {
    expect(COTA_TIERS).toHaveLength(6);
    expect(COTA_TIERS.filter((t) => t.startsWith('OURO'))).toHaveLength(3);
    expect(COTA_TIERS.filter((t) => t.startsWith('DIAMANTE'))).toHaveLength(3);
  });

  it('status de cancelamento cobrem o fluxo do distrato', () => {
    expect(CANCELAMENTO_STATUS).toEqual(['em_analise', 'concluido', 'negado']);
  });

  it('tipos derivam das constantes (união literal, não string)', () => {
    expectTypeOf<TituloStatus>().toEqualTypeOf<(typeof TITULO_STATUS)[number]>();
    expectTypeOf<ContratoStatus>().not.toEqualTypeOf<string>();
    expectTypeOf<Titulo['valorCentavos']>().toEqualTypeOf<number>();
    expectTypeOf<Cotista['titular']>().toEqualTypeOf<string>();
  });
});
