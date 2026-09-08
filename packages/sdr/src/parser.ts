import type { Acao, EstadoFluxo } from './tipos.js';

/**
 * Parser determinístico da resposta do lead. Resolve o óbvio ("4", "2", "1",
 * "sim", "180 mil", "não tenho interesse") sem gastar LLM; devolve null quando
 * não tem certeza — aí o server chama `interpretarResposta`. Em dúvida, null.
 */

export function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
    .replaceAll(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}\s.,$]/gu, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

const RE_CANCELAR =
  /^(nao|n|nao quero|agora nao|cancelar?|cancela|deixa|deixa pra la|depois|esquece|para|parar|nao obrigado|nao obrigada|sem interesse|nao tenho interesse|nao quero comprar|so olhando|so curiosidade)$/;
const RE_CONFIRMAR =
  /^(sim|s|ok|okay|pode|pode sim|pode ser|confirmo|fechado|fechamos|fecho|fecha|bora|vamos|topo|aceito|quero|claro|beleza|certo|isso|isso mesmo|yes|combinado|show)$/;
const RE_PEDIR_MELHOR =
  /\b(melhor|desconto|menos|abaixo|mais barat[oa]|car[oa] demais|muito car[oa]|baixar|negociar|consegue|tem como|da pra|dá pra|melhorar|abater)\b/;

const CARDINAIS: Record<string, number> = {
  um: 1,
  uma: 1,
  dois: 2,
  duas: 2,
  tres: 3,
  quatro: 4,
  cinco: 5,
  seis: 6,
  sete: 7,
  oito: 8,
  nove: 9,
  dez: 10,
};
const ORDINAIS: Record<string, number> = {
  primeira: 1,
  primeiro: 1,
  segunda: 2,
  segundo: 2,
  terceira: 3,
  terceiro: 3,
};

/** Primeiro número pequeno do texto ("4", "4 pessoas", "somos 4", "duas vezes"). */
export function numeroPequeno(t: string): number | null {
  const digito = /(?<![\d.,])(\d{1,2})(?![\d.,])/.exec(t);
  if (digito) return Number(digito[1]);
  for (const palavra of t.split(' ')) {
    const n = CARDINAIS[palavra];
    if (n !== undefined) return n;
  }
  return null;
}

/**
 * Valor em dinheiro ("180 mil", "180.000", "r$ 180.000,00", "200k") → centavos.
 * Só considera dinheiro o que tem "mil"/"k" ou ≥ 1.000 — "2" nunca vira R$ 2.
 */
export function valorDoTexto(t: string): number | null {
  const mil = /(\d+(?:[.,]\d+)?)\s*(?:mil|k)\b/.exec(t);
  if (mil?.[1]) {
    const n = Number(mil[1].replace(',', '.'));
    return Number.isFinite(n) ? Math.round(n * 1000 * 100) : null;
  }
  const reais = /(?:r\$\s*)?(\d{1,3}(?:\.\d{3})+|\d{4,})(?:,(\d{2}))?/.exec(t);
  if (reais?.[1]) {
    const inteiros = Number(reais[1].replaceAll('.', ''));
    const centavos = Number(reais[2] ?? '0');
    if (!Number.isFinite(inteiros) || inteiros < 1000) return null;
    return inteiros * 100 + centavos;
  }
  return null;
}

export function parsearResposta(texto: string, estado: EstadoFluxo): Acao | null {
  const original = texto.trim();
  if (original.includes('👍')) return estado.etapa === 'oferta' ? { tipo: 'aceitar' } : null;
  const t = normalizar(original);
  if (t === '') return null;
  if (RE_CANCELAR.test(t)) return { tipo: 'cancelar' };

  switch (estado.etapa) {
    case 'qualificacao': {
      const n = numeroPequeno(t);
      if (n === null) {
        if (/\b(sozinh[oa]|so eu)\b/.test(t)) return { tipo: 'pessoas', n: 1 };
        if (/\bcasal\b/.test(t)) return { tipo: 'pessoas', n: 2 };
        return null;
      }
      return estado.perfil.pessoas === null ? { tipo: 'pessoas', n } : { tipo: 'periodos', n };
    }
    case 'apresentacao': {
      const numero = /^(\d)$/.exec(t);
      const indice = numero
        ? Number(numero[1])
        : (ORDINAIS[t.replace(/^(a|o) /, '')] ?? (/\bmais barat[oa]\b/.test(t) ? 1 : null));
      if (indice === null || !estado.opcoes[indice - 1]) return null;
      return { tipo: 'escolher', indice };
    }
    case 'oferta': {
      if (RE_CONFIRMAR.test(t)) return { tipo: 'aceitar' };
      const centavos = valorDoTexto(t);
      if (centavos !== null) return { tipo: 'pedir_valor', centavos };
      if (RE_PEDIR_MELHOR.test(t)) return { tipo: 'pedir_melhor' };
      return null;
    }
    case 'agendamento':
      return original.length >= 2 ? { tipo: 'agendar', texto: original.slice(0, 200) } : null;
    default:
      return null;
  }
}
