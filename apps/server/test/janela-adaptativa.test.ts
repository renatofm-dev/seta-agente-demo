import { describe, expect, it } from 'vitest';
import { janelaAdaptativa } from '../src/wa/debounce.ts';

describe('#46 — janela de debounce adaptativa', () => {
  const BASE = 10_000;

  it('pontuação de fecho encurta a espera (0.6x)', () => {
    expect(janelaAdaptativa('quais boletos tenho em aberto?', BASE)).toBe(6_000);
    expect(janelaAdaptativa('quero cancelar meu contrato.', BASE)).toBe(6_000);
    expect(janelaAdaptativa('me ajuda aí!', BASE)).toBe(6_000);
  });

  it('conectivo no fim ou mensagem curta alonga a espera (1.5x)', () => {
    expect(janelaAdaptativa('queria saber do meu saldo e', BASE)).toBe(15_000);
    expect(janelaAdaptativa('sobre as parcelas atrasadas, mas', BASE)).toBe(15_000);
    expect(janelaAdaptativa('me fala do valor da minha', BASE)).toBe(15_000);
    expect(janelaAdaptativa('bom dia,', BASE)).toBe(15_000);
    expect(janelaAdaptativa('oi', BASE)).toBe(15_000); // curta: frase vem aí
  });

  it('frase completa sem fecho usa a base', () => {
    expect(janelaAdaptativa('quero saber o saldo do meu contrato', BASE)).toBe(BASE);
  });

  it('fecho vence a heurística de curta ("oi?" é pergunta feita)', () => {
    expect(janelaAdaptativa('oi?', BASE)).toBe(6_000);
  });
});
