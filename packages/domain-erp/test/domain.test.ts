import {
  BOLETO_STATUS,
  type Boleto,
  type BoletoStatus,
  PEDIDO_STATUS,
  type PedidoStatus,
} from '@seta/domain-erp';
import { describe, expect, expectTypeOf, it } from 'vitest';

describe('domain-erp', () => {
  it('status de boleto cobrem o ciclo de cobrança sem duplicatas', () => {
    expect(BOLETO_STATUS).toContain('aberto');
    expect(BOLETO_STATUS).toContain('vencido');
    expect(new Set(BOLETO_STATUS).size).toBe(BOLETO_STATUS.length);
  });

  it('status de pedido cobrem o ciclo logístico sem duplicatas', () => {
    expect(PEDIDO_STATUS).toContain('em_transporte');
    expect(new Set(PEDIDO_STATUS).size).toBe(PEDIDO_STATUS.length);
  });

  it('tipos derivam das constantes (união literal, não string)', () => {
    expectTypeOf<BoletoStatus>().toEqualTypeOf<(typeof BOLETO_STATUS)[number]>();
    expectTypeOf<PedidoStatus>().not.toEqualTypeOf<string>();
    expectTypeOf<Boleto['valorCentavos']>().toEqualTypeOf<number>();
  });
});
