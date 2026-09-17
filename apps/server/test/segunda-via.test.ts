import { describe, expect, it } from 'vitest';
import { nomeDoArquivo } from '../src/wa/segunda-via.ts';

/**
 * 040 — o nome do arquivo que o cotista vê no WhatsApp.
 *
 * O caso que dá nome a esta suíte: `vencimento` chega do `pg` como **Date**,
 * não como string ISO. Tratar como string produzia `boleto-parcela-100-17.pdf`
 * — nome sem sentido e, pior, o mesmo erro na legenda da mensagem. `isoDia`
 * (014) normaliza as duas formas sem deslocar o dia por fuso.
 */
describe('nomeDoArquivo (040)', () => {
  it('aceita o Date que o pg devolve, sem deslocar o dia', () => {
    expect(nomeDoArquivo(3, new Date(2026, 2, 10))).toBe('boleto-parcela-03-20260310.pdf');
  });

  it('aceita string ISO também — o catálogo pode devolver qualquer uma das duas', () => {
    expect(nomeDoArquivo(3, '2026-03-10')).toBe('boleto-parcela-03-20260310.pdf');
  });

  it('parcela de três dígitos não é truncada', () => {
    expect(nomeDoArquivo(100, '2026-03-10')).toBe('boleto-parcela-100-20260310.pdf');
  });

  it('sem vencimento utilizável, o nome ainda é válido', () => {
    expect(nomeDoArquivo(7, null)).toBe('boleto-parcela-07.pdf');
    expect(nomeDoArquivo(7, 'sei lá')).toBe('boleto-parcela-07.pdf');
  });

  it('só [a-z0-9-] no nome — ele atravessa multipart e aparece na tela do cotista', () => {
    expect(nomeDoArquivo('3/24', '2026-03-10')).toMatch(/^[a-z0-9-]+\.pdf$/);
  });
});
