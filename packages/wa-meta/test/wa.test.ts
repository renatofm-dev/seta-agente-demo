import { OutboundTextSchema, WaPhoneSchema } from '@seta/wa-meta';
import { describe, expect, it } from 'vitest';

describe('wa-meta (esqueleto)', () => {
  it('aceita telefone BR em E.164 sem +', () => {
    expect(WaPhoneSchema.safeParse('5511999999999').success).toBe(true);
  });

  it('rejeita formatos inválidos', () => {
    for (const tel of ['+5511999999999', '011999999999', 'abc', '123']) {
      expect(WaPhoneSchema.safeParse(tel).success).toBe(false);
    }
  });

  it('mensagem respeita o limite de 4096 caracteres da Cloud API', () => {
    expect(
      OutboundTextSchema.safeParse({ to: '5511999999999', body: 'x'.repeat(4096) }).success,
    ).toBe(true);
    expect(
      OutboundTextSchema.safeParse({ to: '5511999999999', body: 'x'.repeat(4097) }).success,
    ).toBe(false);
  });
});
