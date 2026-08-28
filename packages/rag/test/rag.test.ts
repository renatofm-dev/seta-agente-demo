import { describe, expect, it } from 'vitest';
import { tituloDoMarkdown } from '../src/chunking.js';
import { chunkMarkdown, fuseRrf, VectorItemSchema } from '../src/index.js';

describe('VectorItemSchema', () => {
  it('aceita item válido e aplica default de metadados', () => {
    const item = VectorItemSchema.parse({
      id: '018f4d5e-7b7a-7000-8000-000000000001',
      texto: 'Política de trocas em até 7 dias.',
      fonte: 'kb/trocas.md',
      embedding: [0.1, 0.2],
    });
    expect(item.metadados).toEqual({});
    expect(item.embedding).toEqual([0.1, 0.2]);
  });

  it('aceita embedding null (item só-lexical) e rejeita vazio', () => {
    const base = {
      id: '018f4d5e-7b7a-7000-8000-000000000002',
      texto: 'x',
      fonte: 'f',
    };
    expect(VectorItemSchema.parse({ ...base, embedding: null }).embedding).toBeNull();
    expect(() => VectorItemSchema.parse({ ...base, embedding: [] })).toThrow();
  });
});

describe('chunkMarkdown', () => {
  const md = [
    '# Política de Trocas',
    '',
    'Introdução curta.',
    '',
    '## Prazo',
    'Troca em até 7 dias corridos.',
    '',
    '## Condições',
    'Produto sem uso, com nota fiscal.',
  ].join('\n');

  it('agrupa seções pequenas em um chunk até o alvo', () => {
    const chunks = chunkMarkdown(md, { alvoChars: 2000 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.texto).toContain('7 dias corridos');
    expect(chunks[0]?.texto).toContain('nota fiscal');
  });

  it('separa por heading quando o alvo é pequeno e preserva a ordem (seq)', () => {
    const chunks = chunkMarkdown(md, { alvoChars: 60 });
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks.map((c) => c.seq)).toEqual(chunks.map((_, i) => i));
    const comPrazo = chunks.find((c) => c.texto.includes('7 dias corridos'));
    expect(comPrazo?.heading).toBe('Prazo');
  });

  it('fatia seção longa com overlap entre fatias consecutivas', () => {
    const linhas = Array.from({ length: 40 }, (_, i) => `Linha ${i} com conteúdo repetível.`);
    const longo = `## Secao Longa\n${linhas.join('\n')}`;
    const chunks = chunkMarkdown(longo, { alvoChars: 300, overlapChars: 80 });
    expect(chunks.length).toBeGreaterThan(2);
    const [a, b] = [chunks[0]?.texto ?? '', chunks[1]?.texto ?? ''];
    const caudaDeA = a.slice(-40);
    expect(b).toContain(caudaDeA.split('\n').at(-1) ?? '');
  });

  it('extrai o título amigável do primeiro H1', () => {
    expect(tituloDoMarkdown(md)).toBe('Política de Trocas');
    expect(tituloDoMarkdown('sem heading')).toBeNull();
  });
});

describe('fuseRrf', () => {
  const d = (id: string) => ({ id });

  it('documento presente nas duas listas supera topo de lista única', () => {
    const densa = [d('a'), d('b'), d('c')];
    const lexical = [d('b'), d('x')];
    const fundido = fuseRrf([densa, lexical], 3);
    expect(fundido[0]?.id).toBe('b'); // 1/(60+2)+1/(60+1) > 1/(60+1)
  });

  it('respeita k e ordena por score decrescente', () => {
    const fundido = fuseRrf([[d('a'), d('b')], [d('c')]], 2);
    expect(fundido).toHaveLength(2);
    expect((fundido[0]?.score ?? 0) >= (fundido[1]?.score ?? 0)).toBe(true);
  });
});
