import { describe, expect, it } from 'vitest';
import { digitandoAgora } from '../src/wa/dev-routes.js';

/**
 * A bolha "digitando…" do simulador reproduz o estado que liga o indicador no
 * WhatsApp: turno aberto, resposta ainda não enviada. A decisão mora no servidor
 * (e não no componente) porque dentro de um mesmo tique do SSE a mensagem `out`
 * pode chegar ANTES do evento de turno, e porque assim ela é testável.
 */

const TETO = 60_000;
const AGORA = new Date('2026-09-25T12:00:00Z');
const emSegundos = (s: number) => new Date(AGORA.getTime() - s * 1000);

describe('digitandoAgora', () => {
  it('turno aberto sem resposta: está digitando', () => {
    expect(digitandoAgora({ criadoEm: emSegundos(3) }, false, AGORA, TETO)).toBe(true);
  });

  it('turno já respondido: para de digitar', () => {
    expect(digitandoAgora({ criadoEm: emSegundos(3) }, true, AGORA, TETO)).toBe(false);
  });

  it('conversa sem turno nenhum: não digita', () => {
    expect(digitandoAgora(null, false, AGORA, TETO)).toBe(false);
  });

  it('turno mais velho que o teto apaga a bolha, em vez de girar para sempre', () => {
    // é o caso do turno descartado por fusão (#46) e do atendente que assumiu (#47)
    expect(digitandoAgora({ criadoEm: emSegundos(61) }, false, AGORA, TETO)).toBe(false);
  });
});
