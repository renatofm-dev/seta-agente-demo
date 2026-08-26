import { podeTransicionar, TicketStatusSchema } from '@seta/crm';
import { describe, expect, it } from 'vitest';

describe('crm (esqueleto)', () => {
  it('valida status conhecidos e rejeita desconhecidos', () => {
    expect(TicketStatusSchema.safeParse('aguardando_humano').success).toBe(true);
    expect(TicketStatusSchema.safeParse('em_analise').success).toBe(false);
  });

  it('ciclo HITL: bot escala, humano assume e devolve ao bot', () => {
    expect(podeTransicionar('bot', 'aguardando_humano')).toBe(true);
    expect(podeTransicionar('aguardando_humano', 'com_humano')).toBe(true);
    expect(podeTransicionar('com_humano', 'bot')).toBe(true);
  });

  it('ticket fechado é terminal e bot não vira humano direto', () => {
    expect(podeTransicionar('fechado', 'bot')).toBe(false);
    expect(podeTransicionar('bot', 'com_humano')).toBe(false);
  });
});
