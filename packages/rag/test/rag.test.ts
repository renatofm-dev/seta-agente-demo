import { ChunkSchema } from '@seta/rag';
import { describe, expect, it } from 'vitest';

describe('rag (port)', () => {
  it('chunk válido aplica default de metadata', () => {
    const chunk = ChunkSchema.parse({
      id: '01890a5d-ac96-774b-bcce-b302099a8057',
      texto: 'O TS Explorer emite boletos pelo módulo financeiro.',
      fonte: 'kb/financeiro.md',
    });
    expect(chunk.metadata).toEqual({});
  });

  it('rejeita id não-UUID e texto vazio', () => {
    expect(ChunkSchema.safeParse({ id: '123', texto: 'x', fonte: 'kb/a.md' }).success).toBe(false);
    expect(
      ChunkSchema.safeParse({
        id: '01890a5d-ac96-774b-bcce-b302099a8057',
        texto: '',
        fonte: 'kb/a.md',
      }).success,
    ).toBe(false);
  });
});
