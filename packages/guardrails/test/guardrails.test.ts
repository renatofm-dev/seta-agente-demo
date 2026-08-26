import { VerdictSchema } from '@seta/guardrails';
import { describe, expect, it } from 'vitest';

describe('guardrails (esqueleto)', () => {
  it('aceita as três decisões possíveis, sempre com motivo', () => {
    for (const decisao of ['permitir', 'escalar', 'bloquear']) {
      expect(VerdictSchema.safeParse({ decisao, motivo: 'regra x' }).success).toBe(true);
    }
  });

  it('rejeita decisão desconhecida e motivo vazio', () => {
    expect(VerdictSchema.safeParse({ decisao: 'ignorar', motivo: 'x' }).success).toBe(false);
    expect(VerdictSchema.safeParse({ decisao: 'permitir', motivo: '' }).success).toBe(false);
  });
});
