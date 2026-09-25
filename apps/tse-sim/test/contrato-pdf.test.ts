import { describe, expect, it } from 'vitest';
import { contratoPdf, type DadosContrato } from '../src/contrato-pdf.ts';

/**
 * 046 — o contrato sintético do dublê.
 *
 * A estrutura do PDF (objetos e `xref`) já é coberta pelo `boleto-pdf.test.ts`:
 * os dois desenham pela mesma máquina, extraída em `pdf.ts`. O que muda aqui é
 * o CONTEÚDO, e o caso que dá nome à suíte é o plano de pagamento: o contrato
 * 10001 do seed tem 124 parcelas e listá-las uma a uma transborda a página.
 */

const BASE: DadosContrato = {
  vendedora: 'RESORT DEMONSTRACAO MULTIPROPRIEDADE LTDA',
  numeroContrato: '10001',
  dataVenda: '2024-10-24',
  compradorNome: 'Maria da Conceição Ramírez',
  compradorCpf: '000.111.222-33',
  cotaCodigo: 'C101-001',
  tier: 'DIAMANTE PREMIUM',
  unidade: 'TORRE 2 · apto 503 · até 6 hóspedes',
  periodos: 2,
  pontos: 66_000,
  valorTotalReais: 243_708,
  parcelas: [
    { tipo: 'ENTRADA', vencimento: '2024-11-23', valorReais: 2877 },
    { tipo: 'ENTRADA', vencimento: '2024-12-23', valorReais: 2877 },
    { tipo: 'SALDO', vencimento: '2025-03-23', valorReais: 1935 },
    { tipo: 'SALDO', vencimento: '2025-04-22', valorReais: 1935 },
    { tipo: 'SALDO', vencimento: '2025-05-22', valorReais: 1935 },
  ],
  emitidoEm: '2026-09-24',
};

/** O texto que o visualizador mostra — cada `(...) Tj` do fluxo de conteúdo. */
function textos(pdf: Buffer): string[] {
  return [...pdf.toString('latin1').matchAll(/\((.*?)\) Tj/g)].map((m) => m[1] ?? '');
}

describe('contratoPdf (046)', () => {
  it('é um PDF de uma página e não guarda nada além do que recebeu', () => {
    const pdf = contratoPdf(BASE);
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pdf.toString('latin1')).toContain('/Count 1');
  });

  it('agrupa as parcelas por condição — não lista uma a uma', () => {
    const linhas = textos(contratoPdf(BASE));
    expect(linhas).toContain('2x R$ 2.877,00');
    expect(linhas).toContain('3x R$ 1.935,00');
    expect(linhas).toContain('23/11/2024 a 23/12/2024');
    expect(linhas).toContain('23/03/2025 a 22/05/2025');
    // nenhuma data solta de parcela do meio do plano
    expect(linhas).not.toContain('22/04/2025');
  });

  it('parcela única aparece com a data, não com intervalo', () => {
    const linhas = textos(
      contratoPdf({
        ...BASE,
        parcelas: [{ tipo: 'ENTRADA', vencimento: '2026-10-09', valorReais: 2000 }],
      }),
    );
    expect(linhas).toContain('09/10/2026');
    expect(linhas).toContain('R$ 2.000,00');
  });

  it('valores diferentes no mesmo tipo viram contagem + total, sem mentir um valor único', () => {
    const linhas = textos(
      contratoPdf({
        ...BASE,
        parcelas: [
          { tipo: 'SALDO', vencimento: '2026-10-09', valorReais: 1000 },
          { tipo: 'SALDO', vencimento: '2026-11-08', valorReais: 2500 },
        ],
      }),
    );
    expect(linhas).toContain('2 parcelas · R$ 3.500,00');
  });

  it('a tarja de simulado está no papel — este PDF vai parar no WhatsApp de alguém', () => {
    const linhas = textos(contratoPdf(BASE));
    expect(linhas.some((l) => l.includes('DOCUMENTO SIMULADO'))).toBe(true);
    expect(linhas.some((l) => l.includes('validade juridica'))).toBe(true);
  });

  it('traz as partes, o objeto e o número do contrato', () => {
    const linhas = textos(contratoPdf(BASE));
    expect(linhas.some((l) => l.includes('Contrato nº 10001'))).toBe(true);
    expect(linhas).toContain('Maria da Conceição Ramírez');
    expect(linhas).toContain('000.111.222-33');
    expect(linhas).toContain('C101-001');
    expect(linhas).toContain('TORRE 2 · apto 503 · até 6 hóspedes');
  });
});
