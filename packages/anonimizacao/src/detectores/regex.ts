import { resolverSobreposicao } from '../sobreposicao.js';
import type { Deteccao, Detector, TipoPii } from '../tipos.js';
import { cnpjValido, cpfValido, dddValido, luhnValido, somenteDigitos } from '../validadores.js';

/**
 * PII estruturada por regex COM validação. Cada padrão só vira detecção se
 * passar no validador — é o que impede tokenizar contrato `10001`, valor
 * `20825000` ou data `2026-09-06`. Padrões que casam o mesmo trecho (telefone
 * com e sem DDD) são resolvidos aqui: um achado por trecho.
 */

interface Padrao {
  readonly tipo: TipoPii;
  readonly re: RegExp;
  /** Recebe o match; false descarta. */
  readonly valida?: (m: RegExpExecArray) => boolean;
}

const PADROES: readonly Padrao[] = [
  {
    tipo: 'email',
    re: /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu,
  },
  {
    // 000.000.000-00 | 000 000 000 00 | 00000000000 — sempre com DV
    tipo: 'cpf',
    re: /(?<!\d)\d{3}[.\s]?\d{3}[.\s]?\d{3}[-.\s]?\d{2}(?!\d)/g,
    valida: (m) => cpfValido(m[0]),
  },
  {
    tipo: 'cnpj',
    re: /(?<!\d)\d{2}[.\s]?\d{3}[.\s]?\d{3}[/\s]?\d{4}[-\s]?\d{2}(?!\d)/g,
    valida: (m) => cnpjValido(m[0]),
  },
  {
    // 13–19 dígitos com separadores opcionais, Luhn válido
    tipo: 'cartao',
    re: /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g,
    valida: (m) => luhnValido(m[0]),
  },
  {
    // com DDD: +55 (61) 98224-8071 | 61 982248071 | (61)98224-8071
    tipo: 'telefone',
    re: /(?<![\d\p{L}])(?:\+?55[\s.-]?)?\(?(\d{2})\)?[\s.-]?9?\d{4}[\s.-]?\d{4}(?![\d\p{L}])/gu,
    valida: (m) => {
      const d = somenteDigitos(m[0]).replace(/^55(?=\d{10,11}$)/, '');
      if (d.length !== 10 && d.length !== 11) return false;
      if (!dddValido(d.slice(0, 2))) return false;
      // 11 dígitos com DV de CPF é CPF, não telefone
      return !(d.length === 11 && cpfValido(d));
    },
  },
  {
    // sem DDD só quando formatado com hífen: 98224-8071 | 3244-1234
    tipo: 'telefone',
    re: /(?<![\d\p{L}-])9?\d{4}-\d{4}(?![\d\p{L}-])/gu,
  },
  {
    tipo: 'cep',
    re: /(?<!\d)\d{5}-\d{3}(?!\d)/g,
  },
  {
    // "cep 70000000" — sem hífen só com a palavra antes
    tipo: 'cep',
    re: /\bcep:?\s*(\d{5}-?\d{3})(?!\d)/giu,
  },
  {
    // Mercosul ABC1D23 e antiga ABC-1234; maiúsculas de propósito (menos falso positivo)
    tipo: 'placa',
    re: /(?<![\p{L}\d])[A-Z]{3}-?\d[A-Z0-9]\d{2}(?![\p{L}\d])/gu,
  },
];

export function createRegexDetector(): Detector {
  return {
    nome: 'regex',
    detectar(texto) {
      const achados: Deteccao[] = [];
      for (const p of PADROES) {
        p.re.lastIndex = 0;
        for (const m of texto.matchAll(p.re)) {
          if (p.valida && !p.valida(m)) continue;
          const valor = m[0];
          achados.push({
            tipo: p.tipo,
            inicio: m.index,
            fim: m.index + valor.length,
            valor,
            detector: 'regex',
          });
        }
      }
      return resolverSobreposicao(achados);
    },
  };
}
