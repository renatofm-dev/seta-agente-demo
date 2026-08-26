import { toPositional } from '@seta/erp-connector';
import { describe, expect, it } from 'vitest';

describe('toPositional (binds nomeados → posicionais)', () => {
  it('converte tokens na ordem de aparição', () => {
    const r = toPositional('SELECT * FROM v_titulo WHERE cliente_id = :cli AND status = :st', {
      cli: '42',
      st: 'aberto',
    });
    expect(r.text).toBe('SELECT * FROM v_titulo WHERE cliente_id = $1 AND status = $2');
    expect(r.values).toEqual(['42', 'aberto']);
  });

  it('token repetido reusa o mesmo placeholder', () => {
    const r = toPositional('SELECT :a AS x, :b AS y, :a AS z', { a: 1, b: 2 });
    expect(r.text).toBe('SELECT $1 AS x, $2 AS y, $1 AS z');
    expect(r.values).toEqual([1, 2]);
  });

  it('não confunde ::cast do Postgres com bind', () => {
    const r = toPositional('SELECT valor::text FROM v_titulo WHERE cliente_id = :cli', {
      cli: '7',
    });
    expect(r.text).toBe('SELECT valor::text FROM v_titulo WHERE cliente_id = $1');
    expect(r.values).toEqual(['7']);
  });

  it('token sem bind correspondente é erro', () => {
    expect(() => toPositional('SELECT :faltando', {})).toThrow(/bind ausente.*:faltando/);
  });

  it('bind sem token no SQL é erro (pega typo)', () => {
    expect(() => toPositional('SELECT :a', { a: 1, sobrando: 2 })).toThrow(/sobrando/);
  });
});
