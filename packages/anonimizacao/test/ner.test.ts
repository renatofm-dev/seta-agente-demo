import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { agruparPessoas, createNerDetector, janelas, MODELO_NER_DEFAULT } from '@seta/anonimizacao';
import { describe, expect, it } from 'vitest';

/**
 * As partes puras (janelas, agrupamento) rodam sempre. O modelo real só roda
 * se já estiver no cache (`pnpm anonimizacao:modelo`) — o CI não baixa 135 MB.
 */

const CACHE =
  process.env.ANONIMIZACAO_MODELOS_DIR ?? join(import.meta.dirname, '../../../.modelos');
const temModelo = existsSync(join(CACHE, MODELO_NER_DEFAULT));

describe('janelas', () => {
  it('quebra por linha respeitando o máximo, com offsets certos', () => {
    const texto = 'linha um\nlinha dois\nlinha três\n';
    const j = janelas(texto, 20);
    expect(j.map((x) => x.texto)).toEqual(['linha um\nlinha dois\n', 'linha três\n']);
    expect(j.map((x) => x.offset)).toEqual([0, 20]);
    expect(j.every((x) => texto.slice(x.offset, x.offset + x.texto.length) === x.texto)).toBe(true);
  });

  it('linha maior que a janela é fatiada', () => {
    const j = janelas('a'.repeat(45), 20);
    expect(j.map((x) => [x.offset, x.texto.length])).toEqual([
      [0, 20],
      [20, 20],
      [40, 5],
    ]);
  });
});

describe('agruparPessoas', () => {
  it('com offsets do pipeline: B-PER + I-PER viram um span; ORG e score baixo não', () => {
    const texto = 'Falei com Carlos Pereira da Acme ontem';
    const tokens = [
      { entity: 'O', score: 0.99, word: 'Falei', start: 0, end: 5 },
      { entity: 'B-PER', score: 0.98, word: 'Carlos', start: 10, end: 16 },
      { entity: 'I-PER', score: 0.97, word: 'Pereira', start: 17, end: 24 },
      { entity: 'B-ORG', score: 0.9, word: 'Acme', start: 28, end: 32 },
      { entity: 'B-PER', score: 0.3, word: 'ontem', start: 33, end: 38 },
    ];
    expect(agruparPessoas(tokens, texto, 0.6)).toEqual([{ inicio: 10, fim: 24 }]);
  });

  it('sem offsets: localiza as palavras (com ##) sequencialmente no texto', () => {
    const texto = 'oi Renato Martins e Renata';
    const tokens = [
      { entity: 'B-PER', score: 0.9, word: 'Ren' },
      { entity: 'I-PER', score: 0.9, word: '##ato' },
      { entity: 'I-PER', score: 0.9, word: 'Martins' },
      { entity: 'O', score: 0.9, word: 'e' },
      { entity: 'B-PER', score: 0.9, word: 'Renata' },
    ];
    expect(agruparPessoas(tokens, texto, 0.6)).toEqual([
      { inicio: 3, fim: 17 },
      { inicio: 20, fim: 26 },
    ]);
  });
});

describe.skipIf(!temModelo)('NER real (modelo no cache)', () => {
  const ner = createNerDetector({ cacheDir: CACHE, permitirDownload: false });

  it('acha nome de pessoa em posição livre na frase', async () => {
    const achados = await ner.detectar('Falei com o Carlos Eduardo Pereira ontem sobre a parcela.');
    expect(achados).toHaveLength(1);
    expect(achados[0]).toMatchObject({ tipo: 'nome', detector: 'ner' });
    expect(achados[0]?.valor).toBe('Carlos Eduardo Pereira');
  }, 60_000);

  it('não inventa pessoa em texto de contrato', async () => {
    const achados = await ner.detectar(
      'Seu contrato 10001 tem parcela vencida de R$ 1.234,50 com vencimento 2026-09-06 na Torre 2.',
    );
    expect(achados).toEqual([]);
  }, 60_000);

  it('cache: segunda chamada com o mesmo texto devolve o mesmo resultado', async () => {
    const texto = 'A Beatriz Souza ligou.';
    const a = await ner.detectar(texto);
    const b = await ner.detectar(texto);
    expect(b).toBe(a);
  }, 60_000);
});
