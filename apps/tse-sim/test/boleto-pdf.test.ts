import { describe, expect, it } from 'vitest';
import { boletoPdf, type DadosBoleto } from '../src/boleto-pdf.ts';

/**
 * 040 — o boleto sintético do dublê.
 *
 * O PDF é escrito à mão (a stack é travada e não tem lib de PDF), e o que
 * quebra um PDF escrito à mão é sempre a mesma coisa: a `xref`, que publica
 * OFFSET DE BYTE de cada objeto. Estes testes conferem a estrutura de verdade,
 * seguindo os offsets — não só que a string "%PDF" está lá.
 */

const DADOS: DadosBoleto = {
  cedente: 'RESORT DEMONSTRACAO MULTIPROPRIEDADE LTDA',
  sacado: 'Maria da Conceição Ramírez',
  sacadoCpf: '000.111.222-33',
  nossoNumero: '14000000000030012-9',
  contrato: '10002',
  parcela: '3/24',
  vencimento: '2026-03-10',
  valorReais: 1234.56,
  linhaDigitavel: '34191.79001 01043.510047 91020.150008 8 98770000123456',
  emitidoEm: '2026-09-17',
};

/** Lê a tabela xref e confere que cada offset aponta para o `N 0 obj` certo. */
function conferirXref(pdf: Buffer): number {
  const texto = pdf.toString('latin1');
  const inicio = Number(texto.slice(texto.lastIndexOf('startxref')).split('\n')[1]);
  expect(texto.slice(inicio, inicio + 4)).toBe('xref');
  // linhas: [0]='xref', [1]='0 N', [2]=entrada 0 (a livre), [2+i]=objeto i
  const linhas = texto.slice(inicio).split('\n');
  const [, total] = (linhas[1] ?? '').split(' ').map(Number);
  for (let i = 1; i < (total ?? 0); i++) {
    const offset = Number((linhas[2 + i] ?? '').slice(0, 10));
    expect(texto.slice(offset, offset + `${i} 0 obj`.length)).toBe(`${i} 0 obj`);
  }
  return total ?? 0;
}

describe('boleto sintético em PDF (040)', () => {
  it('é um PDF com cabeçalho, trailer e uma página', () => {
    const pdf = boletoPdf(DADOS);
    const texto = pdf.toString('latin1');
    expect(texto.startsWith('%PDF-1.4')).toBe(true);
    expect(texto.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(texto).toContain('/Type /Catalog');
    expect(texto).toContain('/Count 1');
  });

  it('a xref aponta para o byte certo de cada objeto', () => {
    expect(conferirXref(boletoPdf(DADOS))).toBe(8); // 7 objetos + a entrada livre
  });

  it('o /Length do fluxo bate com os bytes do conteúdo', () => {
    const texto = boletoPdf(DADOS).toString('latin1');
    const declarado = Number(/<< \/Length (\d+) >>/.exec(texto)?.[1]);
    const inicio = texto.indexOf('stream\n') + 'stream\n'.length;
    const fim = texto.indexOf('\nendstream');
    expect(fim - inicio).toBe(declarado);
  });

  it('acento do nome sobrevive — WinAnsi, e o byte é latin-1', () => {
    const pdf = boletoPdf(DADOS);
    expect(pdf.toString('latin1')).toContain('Maria da Conceição Ramírez');
    expect(pdf.toString('latin1')).toContain('/Encoding /WinAnsiEncoding');
  });

  it('parêntese no nome não quebra o literal do PDF', () => {
    const pdf = boletoPdf({ ...DADOS, sacado: 'ACME (Filial) \\ Ltda' });
    expect(pdf.toString('latin1')).toContain('ACME \\(Filial\\) \\\\ Ltda');
    expect(conferirXref(pdf)).toBe(8);
  });

  it('diz no papel que é simulado — um boleto que parece pagável e não é seria pior', () => {
    const texto = boletoPdf(DADOS).toString('latin1');
    expect(texto).toContain('DOCUMENTO SIMULADO');
    expect(texto).toContain('nao e pagavel');
  });

  it('a linha digitável quebra num ESPAÇO, nunca no meio de um grupo', () => {
    const texto = boletoPdf(DADOS).toString('latin1');
    expect(texto).toContain('(34191.79001 01043.510047) Tj');
    expect(texto).toContain('(91020.150008 8 98770000123456) Tj');
  });

  it('linha digitável sem espaço nenhum ainda gera PDF válido', () => {
    const pdf = boletoPdf({ ...DADOS, linhaDigitavel: '1'.repeat(47) });
    expect(conferirXref(pdf)).toBe(8);
  });

  it('valor e vencimento saem no formato do Brasil', () => {
    const texto = boletoPdf(DADOS).toString('latin1');
    expect(texto).toContain('R$ 1.234,56');
    expect(texto).toContain('10/03/2026');
  });
});
