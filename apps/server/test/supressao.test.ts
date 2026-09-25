import { describe, expect, it } from 'vitest';
import { ehPedidoDeSaida } from '../src/wa/supressao.ts';

/**
 * 044 — o reconhecimento do pedido de saída.
 *
 * Esta suíte existe por causa de UM caso, e ele está no primeiro `describe` de
 * baixo: **"quero cancelar meu contrato" NÃO é opt-out**. Em multipropriedade,
 * "cancelar" quase sempre é distrato — assunto que tem tool, skill e escalada
 * para humano. Suprimir quem pediu para cancelar o contrato trocaria a conversa
 * mais delicada do negócio por silêncio permanente.
 *
 * O reconhecimento é determinístico de propósito (não passa pelo classificador
 * de intenção): opt-out tem de funcionar com o LLM fora do ar.
 */

describe('pedido de saída: o que reconhece', () => {
  it('a palavra sozinha, em qualquer caixa, com pontuação ou espaço sobrando', () => {
    for (const texto of ['sair', 'SAIR', 'Sair!', '  parar  ', 'PARE', 'stop', 'Descadastrar']) {
      expect(ehPedidoDeSaida(texto), texto).toBe(true);
    }
  });

  it('acento não muda nada — o texto é normalizado', () => {
    expect(ehPedidoDeSaida('não quero mais receber')).toBe(true);
    expect(ehPedidoDeSaida('nao quero mais receber')).toBe(true);
    expect(ehPedidoDeSaida('NÃO QUERO MAIS RECEBER MENSAGENS')).toBe(true);
  });

  it('frases sobre MENSAGEM valem dentro de um texto maior', () => {
    expect(ehPedidoDeSaida('oi, por favor pare de me mandar mensagem, obrigado')).toBe(true);
    expect(ehPedidoDeSaida('bom dia, me tira da lista por favor')).toBe(true);
    expect(ehPedidoDeSaida('gostaria de remover meu numero desses envios')).toBe(true);
  });
});

describe('pedido de saída: o que NÃO reconhece', () => {
  it('"cancelar" é distrato, não opt-out — o caso que dá nome a esta suíte', () => {
    expect(ehPedidoDeSaida('quero cancelar meu contrato')).toBe(false);
    expect(ehPedidoDeSaida('cancelar')).toBe(false);
    expect(ehPedidoDeSaida('como faço para cancelar a minha cota?')).toBe(false);
    expect(ehPedidoDeSaida('preciso cancelar minha reserva de dezembro')).toBe(false);
  });

  it('a palavra dentro de uma frase comum não é pedido de saída', () => {
    expect(ehPedidoDeSaida('vou sair de férias em janeiro')).toBe(false);
    expect(ehPedidoDeSaida('quero sair do hotel mais cedo')).toBe(false);
    expect(ehPedidoDeSaida('pode parar a cobrança automática?')).toBe(false);
    expect(ehPedidoDeSaida('preciso remover um hóspede da reserva')).toBe(false);
  });

  it('mensagem vazia ou só pontuação não suprime ninguém', () => {
    for (const texto of ['', '   ', '...', '!!!']) {
      expect(ehPedidoDeSaida(texto), JSON.stringify(texto)).toBe(false);
    }
  });

  it('pedir a 2ª via ou pagar continua sendo pedir a 2ª via ou pagar', () => {
    expect(ehPedidoDeSaida('me manda a segunda via do boleto')).toBe(false);
    expect(ehPedidoDeSaida('quero pagar minha parcela')).toBe(false);
  });
});
