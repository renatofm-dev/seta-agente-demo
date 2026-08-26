import { AgentTurnInputSchema } from '@seta/agent';
import { describe, expect, it } from 'vitest';

describe('agent (esqueleto)', () => {
  it('aceita turno válido com traceId UUID', () => {
    const parsed = AgentTurnInputSchema.safeParse({
      traceId: '01890a5d-ac96-774b-bcce-b302099a8057',
      contatoId: '5511999999999',
      texto: 'quais boletos tenho em aberto?',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejeita traceId não-UUID e texto vazio ou acima do limite', () => {
    const base = { traceId: 'nao-uuid', contatoId: 'c1', texto: 'oi' };
    expect(AgentTurnInputSchema.safeParse(base).success).toBe(false);
    expect(
      AgentTurnInputSchema.safeParse({
        ...base,
        traceId: '01890a5d-ac96-774b-bcce-b302099a8057',
        texto: '',
      }).success,
    ).toBe(false);
    expect(
      AgentTurnInputSchema.safeParse({
        ...base,
        traceId: '01890a5d-ac96-774b-bcce-b302099a8057',
        texto: 'x'.repeat(4097),
      }).success,
    ).toBe(false);
  });
});
