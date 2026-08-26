import { applyMasking } from '@seta/query-catalog';
import { describe, expect, it } from 'vitest';

describe('masking por coluna', () => {
  it('cnpj: mascara tudo menos os dois dígitos verificadores', () => {
    const rows = applyMasking([{ documento: '12.345.678/0001-95', razao_social: 'ACME Ltda' }], {
      documento: 'cnpj',
    });
    expect(rows[0]?.documento).toBe('**.***.***/****-95');
    expect(rows[0]?.razao_social).toBe('ACME Ltda'); // colunas sem masking ficam intactas
  });

  it('valor não-CNPJ vira *** (nunca vaza parcial malformado)', () => {
    const rows = applyMasking([{ documento: '123' }], { documento: 'cnpj' });
    expect(rows[0]?.documento).toBe('***');
  });

  it('sem masking configurado, retorna cópia sem alteração', () => {
    const originais = [{ a: 1 }];
    const rows = applyMasking(originais, {});
    expect(rows).toEqual(originais);
    expect(rows).not.toBe(originais);
  });
});
