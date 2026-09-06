import { cnpjValido, cpfValido, dddValido, luhnValido } from '@seta/anonimizacao';
import { describe, expect, it } from 'vitest';

describe('validadores de dígito verificador', () => {
  it('CPF: DV correto com e sem pontuação; sequência repetida e DV errado não', () => {
    expect(cpfValido('529.982.247-25')).toBe(true);
    expect(cpfValido('52998224725')).toBe(true);
    expect(cpfValido('123.456.789-09')).toBe(true);
    expect(cpfValido('111.111.111-11')).toBe(false);
    expect(cpfValido('123.456.789-00')).toBe(false);
    expect(cpfValido('10001')).toBe(false);
  });

  it('CNPJ', () => {
    expect(cnpjValido('11.222.333/0001-81')).toBe(true);
    expect(cnpjValido('11222333000181')).toBe(true);
    expect(cnpjValido('11.222.333/0001-80')).toBe(false);
    expect(cnpjValido('00.000.000/0000-00')).toBe(false);
  });

  it('Luhn (cartão)', () => {
    expect(luhnValido('4111 1111 1111 1111')).toBe(true);
    expect(luhnValido('5500000000000004')).toBe(true);
    expect(luhnValido('4111111111111112')).toBe(false);
    expect(luhnValido('1234')).toBe(false);
  });

  it('DDD brasileiro: 11–99', () => {
    expect(dddValido('61')).toBe(true);
    expect(dddValido('11')).toBe(true);
    expect(dddValido('10')).toBe(false);
    expect(dddValido('00')).toBe(false);
    expect(dddValido('6')).toBe(false);
  });
});
