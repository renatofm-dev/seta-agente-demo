/**
 * Validação de dígito verificador — é o que separa um CPF de um número de
 * contrato ou de um valor em centavos com 11 dígitos. Sem isso o regex
 * tokenizaria dado que o guardrail de preço precisa ver.
 */

export function somenteDigitos(s: string): string {
  return s.replaceAll(/\D/g, '');
}

function todosIguais(d: string): boolean {
  return /^(\d)\1+$/.test(d);
}

export function cpfValido(entrada: string): boolean {
  const d = somenteDigitos(entrada);
  if (d.length !== 11 || todosIguais(d)) return false;
  const dv = (base: string, pesoInicial: number): number => {
    let soma = 0;
    for (let i = 0; i < base.length; i++) {
      soma += Number(base[i]) * (pesoInicial - i);
    }
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };
  return dv(d.slice(0, 9), 10) === Number(d[9]) && dv(d.slice(0, 10), 11) === Number(d[10]);
}

export function cnpjValido(entrada: string): boolean {
  const d = somenteDigitos(entrada);
  if (d.length !== 14 || todosIguais(d)) return false;
  const dv = (base: string): number => {
    const pesos =
      base.length === 12
        ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
        : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let soma = 0;
    for (let i = 0; i < base.length; i++) {
      soma += Number(base[i]) * (pesos[i] as number);
    }
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };
  return dv(d.slice(0, 12)) === Number(d[12]) && dv(d.slice(0, 13)) === Number(d[13]);
}

/** Luhn — cartão de crédito/débito (13 a 19 dígitos). */
export function luhnValido(entrada: string): boolean {
  const d = somenteDigitos(entrada);
  if (d.length < 13 || d.length > 19 || todosIguais(d)) return false;
  let soma = 0;
  let dobra = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = Number(d[i]);
    if (dobra) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    soma += n;
    dobra = !dobra;
  }
  return soma % 10 === 0;
}

/** DDD brasileiro válido: 11–99 (o 0 e o 10 não existem). */
export function dddValido(ddd: string): boolean {
  const n = Number(ddd);
  return ddd.length === 2 && n >= 11 && n <= 99;
}
