import type { Acao, EstadoFluxo } from './tipos.js';

/**
 * Parser determinístico do fluxo de reserva. Síncrono, sem custo, e **em dúvida
 * devolve `null`** — nunca chuta; quem chuta é o `interpretar.ts`, e só quando
 * este aqui desistiu.
 *
 * Ele é também o **guardião do CPF**. O decorator de anonimização (016) troca
 * CPF por token no que vai para a LLM e destokeniza na volta, mas token
 * desconhecido passa intacto — e um `[CPF_1]` gravado no ERP é dado errado num
 * sistema de terceiro. Por isso o CPF só existe como saída DESTE arquivo, sobre
 * o texto CRU do cotista, com dígito verificador conferido.
 */

const MESES: Record<string, number> = {
  janeiro: 1,
  jan: 1,
  fevereiro: 2,
  fev: 2,
  marco: 3,
  mar: 3,
  abril: 4,
  abr: 4,
  maio: 5,
  mai: 5,
  junho: 6,
  jun: 6,
  julho: 7,
  jul: 7,
  agosto: 8,
  ago: 8,
  setembro: 9,
  set: 9,
  outubro: 10,
  out: 10,
  novembro: 11,
  nov: 11,
  dezembro: 12,
  dez: 12,
};

const NUMEROS: Record<string, number> = {
  zero: 0,
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
  primeiro: 1,
  primeira: 1,
  segundo: 2,
  segunda: 2,
  terceiro: 3,
  terceira: 3,
  quarto: 4,
  quarta: 4,
  quinto: 5,
  quinta: 5,
};

export function normalizar(texto: string): string {
  return texto.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

const CANCELAR = /\b(cancel\w*|desist\w*|deixa\s*pra\s*la|nao\s*quero\s*mais|esquece)\b/;
const CONFIRMAR =
  /\b(sim|isso|confirmo?|confirmar|pode\s*(ser|confirmar)|ok|beleza|fechado|certo|correto|perfeito)\b|^\s*(?:👍|✅)\s*$/;
const PRONTO =
  /\b(so|somente|apenas)?\s*(isso|eu|essas?|esses?)\b|\bpronto\b|\bmais\s*ninguem\b|\bso\s*eu\b/;

/** CPF com DV conferido. Token de anonimização (`[CPF_1]`) nunca passa daqui. */
export function cpfValido(bruto: string): string | null {
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
  // um token de anonimização NUNCA é CPF, mesmo que escape para cá
  if (/\[[A-Z_]+\d*\]/.test(texto)) return null;
  for (const m of texto.matchAll(/\d[\d.\-\s]{9,17}\d/g)) {
    const cpf = cpfValido(m[0]);
    if (cpf) return cpf;
  }
  return null;
}

const ano = (mes: number, dia: number, hoje = new Date()): number => {
  const atual = hoje.getUTCFullYear();
  const candidato = Date.UTC(atual, mes - 1, dia);
  // data já passada neste ano ⇒ o cotista está falando do ano que vem
  return candidato < Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate())
    ? atual + 1
    : atual;
};

const iso = (a: number, m: number, d: number): string =>
  `${a}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/**
 * Datas do período. Cobre as três formas que aparecem numa conversa:
 * `de 10/05 a 13/05`, `de 10 a 13 de maio` e `2027-05-10 a 2027-05-13`.
 */
export function extrairPeriodo(
  texto: string,
  hoje = new Date(),
): { checkIn: string; checkOut: string } | null {
  const t = normalizar(texto);

  const isoDuplo = [...t.matchAll(/(\d{4})-(\d{2})-(\d{2})/g)];
  if (isoDuplo.length >= 2) {
    const [a, b] = isoDuplo as [RegExpMatchArray, RegExpMatchArray];
    return { checkIn: a[0], checkOut: b[0] };
  }

  const barra = [...t.matchAll(/\b(\d{1,2})\s*\/\s*(\d{1,2})(?:\s*\/\s*(\d{2,4}))?/g)];
  if (barra.length >= 2) {
    const [a, b] = barra as [RegExpMatchArray, RegExpMatchArray];
    const [d1, m1] = [Number(a[1]), Number(a[2])];
    const [d2, m2] = [Number(b[1]), Number(b[2])];
    if (m1 >= 1 && m1 <= 12 && m2 >= 1 && m2 <= 12) {
      const a1 = a[3] ? Number(a[3].padStart(4, '20')) : ano(m1, d1, hoje);
      const a2 = b[3] ? Number(b[3].padStart(4, '20')) : a1;
      return { checkIn: iso(a1, m1, d1), checkOut: iso(a2, m2, d2) };
    }
  }

  // "de 10 a 13 de maio" / "10 até 17 de julho"
  const porExtenso = t.match(/\b(\d{1,2})\s*(?:a|ate|-)\s*(\d{1,2})\s*d[eo]\s*([a-z]+)/);
  if (porExtenso) {
    const mes = MESES[porExtenso[3] as string];
    if (mes) {
      const d1 = Number(porExtenso[1]);
      const d2 = Number(porExtenso[2]);
      const a1 = ano(mes, d1, hoje);
      return { checkIn: iso(a1, mes, d1), checkOut: iso(a1, mes, d2) };
    }
  }
  return null;
}

/** "2 adultos e 1 criança", "somos 3", "duas pessoas". */
export function extrairPagantes(texto: string): { adultos: number; criancas: number } | null {
  const t = normalizar(texto);
  const valorDe = (trecho: string | undefined): number | null => {
    if (!trecho) return null;
    if (/^\d{1,2}$/.test(trecho)) return Number(trecho);
    return NUMEROS[trecho] ?? null;
  };
  // o número que conta é o IMEDIATAMENTE anterior à palavra: em "2 adultos e 1
  // criança", um `match` largo pegaria o 2 para os dois
  const adultoM = t.match(/(\d{1,2}|[a-z]+)\s+adultos?\b/);
  const criancaM = t.match(/(\d{1,2}|[a-z]+)\s+(?:criancas?|filhos?)\b/);
  if (adultoM || criancaM) {
    const adultos = valorDe(adultoM?.[1]) ?? 1;
    const criancas = valorDe(criancaM?.[1]) ?? 0;
    return { adultos, criancas };
  }
  // "somos 3", "vamos em 4", "3 pessoas"
  const total = t.match(
    /\b(?:somos|vamos em|seremos)\s+(\d{1,2}|[a-z]+)\b|\b(\d{1,2}|[a-z]+)\s+pessoas?\b/,
  );
  if (total) {
    const n = valorDe(total[1] ?? total[2]);
    if (n !== null && n > 0 && n <= 20) return { adultos: n, criancas: 0 };
  }
  return null;
}

/**
 * Palavras de cola que aparecem antes de um nome. A comparação é feita sobre a
 * forma SEM acento: `\bé\b` não casa em JS sem a flag `u` (`é` não é word char),
 * e foi assim que "o nome é Maria" virou "é" na primeira versão.
 */
const COLA = new Set([
  'cpf',
  'rg',
  'e',
  'eh',
  'o',
  'a',
  'nome',
  'completo',
  'do',
  'da',
  'de',
  'dele',
  'dela',
  'meu',
  'minha',
  'sou',
  'chamo',
  'me',
  'ela',
  'ele',
  'documento',
  'numero',
]);

/** Nome do hóspede: o que sobra do texto depois de tirar o CPF e as palavras de cola. */
export function extrairNome(texto: string): { nome: string; sobrenome: string | null } | null {
  const partes = texto
    .replace(/\d[\d.\-\s]{9,17}\d/g, ' ')
    .replace(/\[[A-Z_]+\d*\]/g, ' ')
    .replace(/[^\p{L}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !COLA.has(normalizar(w)));
  if (partes.length === 0) return null;
  return {
    nome: partes[0] as string,
    sobrenome: partes.length > 1 ? partes.slice(1).join(' ') : null,
  };
}

function ordinal(texto: string, maximo: number): number | null {
  const t = normalizar(texto);
  const digito = t.match(/\b(\d{1,2})\b/);
  if (digito) {
    const n = Number(digito[1]);
    return n >= 1 && n <= maximo ? n : null;
  }
  for (const [palavra, valor] of Object.entries(NUMEROS)) {
    if (new RegExp(`\\b${palavra}\\b`).test(t) && valor >= 1 && valor <= maximo) return valor;
  }
  return null;
}

export function parsearResposta(
  texto: string,
  estado: EstadoFluxo,
  hoje = new Date(),
): Acao | null {
  const t = normalizar(texto);
  if (CANCELAR.test(t)) return { tipo: 'cancelar' };

  switch (estado.etapa) {
    case 'periodo': {
      const p = extrairPeriodo(texto, hoje);
      return p ? { tipo: 'periodo', ...p } : null;
    }
    case 'hotel': {
      const i = ordinal(texto, estado.hoteis.length);
      if (i !== null) return { tipo: 'escolher', indice: i };
      // "quero a torre 2" — casa pelo nome mostrado
      const achado = estado.hoteis.findIndex((h) => t.includes(normalizar(h.descricao)));
      return achado >= 0 ? { tipo: 'escolher', indice: achado + 1 } : null;
    }
    case 'unidade': {
      const i = ordinal(texto, estado.tiposUh.length);
      if (i !== null) return { tipo: 'escolher', indice: i };
      const achado = estado.tiposUh.findIndex((u) => t.includes(normalizar(u.descricao)));
      return achado >= 0 ? { tipo: 'escolher', indice: achado + 1 } : null;
    }
    case 'pagantes': {
      const p = extrairPagantes(texto);
      return p ? { tipo: 'pagantes', ...p } : null;
    }
    case 'hospedes': {
      if (PRONTO.test(t)) return { tipo: 'pronto' };
      const cpf = extrairCpf(texto);
      const nome = extrairNome(texto);
      if (!nome) return null;
      return { tipo: 'hospede', nome: nome.nome, sobrenome: nome.sobrenome, cpf };
    }
    case 'confirmacao':
      return CONFIRMAR.test(t) ? { tipo: 'confirmar' } : null;
    default:
      return null;
  }
}
