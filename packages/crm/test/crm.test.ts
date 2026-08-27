import {
  podeTransicionar,
  TicketStatusSchema,
  TransicaoInvalidaError,
  transicionar,
} from '@seta/crm';
import { describe, expect, it } from 'vitest';

describe('máquina de estados do ticket (spec 007)', () => {
  it('valida status conhecidos e rejeita desconhecidos', () => {
    expect(TicketStatusSchema.safeParse('aguardando_humano').success).toBe(true);
    expect(TicketStatusSchema.safeParse('em_analise').success).toBe(false);
  });

  it('ciclo HITL completo é permitido', () => {
    expect(podeTransicionar('bot_ativo', 'aguardando_humano')).toBe(true); // escalada
    expect(podeTransicionar('aguardando_humano', 'humano_ativo')).toBe(true); // assumir
    expect(podeTransicionar('humano_ativo', 'bot_ativo')).toBe(true); // devolver
    expect(podeTransicionar('humano_ativo', 'resolvido')).toBe(true); // resolver
    expect(podeTransicionar('resolvido', 'bot_ativo')).toBe(true); // reabertura
    expect(podeTransicionar('aguardando_humano', 'bot_ativo')).toBe(true); // devolver sem assumir
  });

  it('transições inválidas lançam erro (critério 007)', () => {
    expect(() => transicionar('bot_ativo', 'humano_ativo', 'atendente')).toThrow(
      TransicaoInvalidaError,
    );
    expect(() => transicionar('resolvido', 'humano_ativo', 'atendente')).toThrow(
      /resolvido → humano_ativo/,
    );
    expect(() => transicionar('aguardando_humano', 'resolvido', 'atendente')).toThrow(
      TransicaoInvalidaError,
    );
    expect(() => transicionar('bot_ativo', 'bot_ativo', 'sistema')).toThrow(TransicaoInvalidaError);
  });

  it('transição válida devolve o registro para o evento_ticket', () => {
    const t = transicionar('bot_ativo', 'aguardando_humano', 'bot', {
      motivo: 'pedido de desconto',
    });
    expect(t).toEqual({
      de: 'bot_ativo',
      para: 'aguardando_humano',
      ator: 'bot',
      motivo: 'pedido de desconto',
    });
  });
});
