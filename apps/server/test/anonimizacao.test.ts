import { describe, expect, it } from 'vitest';
import { createAcumuladorAnonimizacao } from '../src/anonimizacao.ts';

describe('acumulador de anonimização por traceId (016)', () => {
  it('soma as chamadas do mesmo turno e limpa ao consumir', () => {
    const ac = createAcumuladorAnonimizacao();
    const base = { operacao: 'chat' as const, modelo: 'm', latenciaMs: 5, tokensDesconhecidos: 0 };
    ac.sink({ ...base, traceId: 't1', substituicoes: { cpf: 1, nome: 1 }, total: 2 });
    ac.sink({
      ...base,
      traceId: 't1',
      substituicoes: { cpf: 1 },
      total: 1,
      tokensDesconhecidos: 1,
    });
    ac.sink({ ...base, traceId: 't2', substituicoes: { email: 1 }, total: 1 });
    ac.sink({ ...base, substituicoes: { cpf: 9 }, total: 9 }); // sem traceId: ignorado

    expect(ac.consumir('t1')).toEqual({
      tipo: 'anonimizacao',
      chamadas: 2,
      substituicoes: { cpf: 2, nome: 1 },
      tokensDesconhecidos: 1,
      latenciaMs: 10,
    });
    expect(ac.consumir('t1')).toBeNull(); // consumido
    expect(ac.consumir('t2')?.substituicoes).toEqual({ email: 1 });
    expect(ac.consumir('t3')).toBeNull();
  });
});
