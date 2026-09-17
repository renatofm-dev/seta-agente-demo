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

/**
 * 045 — CPF do comprador. Cópia deliberada de `packages/reserva/src/parser.ts`:
 * os dois domínios são irmãos e não se importam, e acoplá-los por uma função
 * pura de 15 linhas seria pior que repeti-la. A matemática do DV não diverge.
 *
 * A primeira linha é a que importa: **um token de anonimização nunca é CPF**.
 * O decorator da 016 devolve `[CPF_1]` no lugar do número, e gravar isso num
 * ERP de terceiro é um dado errado que ninguém corrige depois.
 */
function cpfValido(bruto: string): string | null {
  const d = bruto.replace(/\D/g, '');
  if (d.length !== 11) return null;
  if (/^(\d)\1{10}$/.test(d)) return null;
  const dv = (n: number): number => {
    let soma = 0;
    for (let i = 0; i < n; i++) soma += Number(d[i]) * (n + 1 - i);
    const r = (soma * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return dv(9) === Number(d[9]) && dv(10) === Number(d[10]) ? d : null;
}

export function extrairCpf(texto: string): string | null {
  if (/\[[A-Z_]+\d*\]/.test(texto)) return null;
  for (const m of texto.matchAll(/\d[\d.\-\s]{9,17}\d/g)) {
    const cpf = cpfValido(m[0]);
    if (cpf) return cpf;
  }
  return null;
}

/**
 * Nome completo: o que sobra do texto depois de tirar o CPF e as palavras de
 * ligação. Exige duas palavras — "João" não é nome completo, e o TSE grava o
 * que receber.
 */
export function extrairNome(texto: string): string | null {
  const semCpf = texto.replace(/\d[\d.\-\s]{9,17}\d/g, ' ');
  const limpo = semCpf
    .replaceAll(/\b(meu|nome|completo|e|eh|é|sou|o|a|cpf|numero|número)\b/gi, ' ')
    .replaceAll(/[^\p{L}\s']/gu, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
  const partes = limpo.split(' ').filter((p) => p.length >= 2);
  if (partes.length < 2) return null;
  return partes
    .slice(0, 6)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join(' ')
    .slice(0, 120);
}

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
    case 'dados': {
      // pedir humano tem precedência: quem quer gente não quer preencher dados
      if (/\b(atendente|humano|pessoa|ligar|telefone|falar com)\b/.test(t)) {
        return { tipo: 'agendar', texto: original.slice(0, 200) };
      }
      const cpf = extrairCpf(original);
      const nome = extrairNome(original);
      return cpf && nome ? { tipo: 'dados', nome, cpf } : null;
    }
    case 'fechamento':
      // nada que o lead escreva avança o fechamento — quem avança é o PSP.
      // Só o pedido explícito de humano tem efeito.
      return /\b(atendente|humano|pessoa|ligar|falar com)\b/.test(t)
        ? { tipo: 'agendar', texto: original.slice(0, 200) }
        : null;
    case 'agendamento':
      return original.length >= 2 ? { tipo: 'agendar', texto: original.slice(0, 200) } : null;
    default:
      return null;
  }
}
