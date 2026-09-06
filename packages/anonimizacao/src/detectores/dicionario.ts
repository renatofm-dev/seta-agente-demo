import type { Deteccao, Detector } from '../tipos.js';

/**
 * Nomes de pessoa por duas vias baratas:
 * - dicionário de contexto: o nome do próprio contato (e o apelido do vínculo),
 *   que é o caso mais comum no atendimento — "Oi Renato" do atendente;
 * - gatilhos: "meu nome é X", "me chamo X", "aqui é o X", "sou a X".
 * O NER (ner.ts) cobre o resto; este detector nunca depende dele.
 */

export interface DicionarioConfig {
  /** Nomes conhecidos — pode ser assíncrono (lê do banco com TTL). */
  readonly nomes: () => readonly string[] | Promise<readonly string[]>;
  /** Liga as frases-gatilho (default true). */
  readonly gatilhos?: boolean;
}

/** Palavras que aparecem em apelidos/nomes mas não são nome de pessoa. */
const STOP = new Set([
  'contrato',
  'titular',
  'cliente',
  'cota',
  'senhor',
  'senhora',
  'sr',
  'sra',
  'dr',
  'dra',
  'com',
  'sem',
  'dos',
  'das',
  'del',
  'para',
  'por',
]);

const NOME_QUALQUER = String.raw`[\p{L}][\p{L}'-]+(?:\s+(?:d[aeo]s?\s+)?[\p{L}][\p{L}'-]+){0,3}`;

/** Gatilho forte: o que vem depois é nome mesmo em minúscula ("me chamo joão"). */
const RE_GATILHO_FORTE = new RegExp(
  String.raw`\b(?:meu nome é|me chamo|nome:)\s+(${NOME_QUALQUER})`,
  'giu',
);
/**
 * Gatilho fraco: exige inicial maiúscula ("sou a favor" não é nome). A checagem
 * é feita fora do regex — com a flag `i`, `\p{Lu}` casaria minúscula também.
 */
const RE_GATILHO_FRACO = new RegExp(
  String.raw`\b(?:aqui é (?:o|a)|sou (?:o|a)|quem fala é (?:o|a)|aqui quem fala é (?:o|a))\s+(${NOME_QUALQUER})`,
  'giu',
);
const RE_INICIAL_MAIUSCULA = /^\p{Lu}/u;

function escapar(s: string): string {
  return s.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Partes utilizáveis de um nome: ≥3 letras, sem dígito, fora da stoplist.
 * Parênteses caem antes ("Renan (com 9)" ⇒ "Renan"); parte com dígito cai
 * sozinha ("Contrato 10001" ⇒ nada).
 */
export function partesDeNome(nome: string): string[] {
  const limpo = nome.replaceAll(/\([^)]*\)/g, ' ');
  const partes = limpo
    .split(/\s+/)
    .map((p) => p.trim())
    .filter(
      (p) =>
        p.length >= 3 && !/\d/.test(p) && /^[\p{L}'-]+$/u.test(p) && !STOP.has(p.toLowerCase()),
    );
  // o nome completo primeiro (span mais longo vence na resolução de sobreposição)
  const completo = partes.length >= 2 ? [partes.join(' ')] : [];
  return [...completo, ...partes];
}

export function createDicionarioDetector(cfg: DicionarioConfig): Detector {
  const usaGatilhos = cfg.gatilhos ?? true;
  return {
    nome: 'dicionario',
    async detectar(texto) {
      const achados: Deteccao[] = [];
      const nomes = await cfg.nomes();
      const termos = new Set<string>();
      for (const n of nomes) for (const p of partesDeNome(n)) termos.add(p);
      for (const termo of termos) {
        // fronteira por letra (não \b: acento não é \w sem a flag u, e mesmo com ela \b é ASCII)
        const re = new RegExp(`(?<![\\p{L}])${escapar(termo)}(?![\\p{L}])`, 'giu');
        for (const m of texto.matchAll(re)) {
          achados.push({
            tipo: 'nome',
            inicio: m.index,
            fim: m.index + m[0].length,
            valor: m[0],
            detector: 'dicionario',
          });
        }
      }
      if (usaGatilhos) {
        for (const [re, exigeMaiuscula] of [
          [RE_GATILHO_FORTE, false],
          [RE_GATILHO_FRACO, true],
        ] as const) {
          for (const m of texto.matchAll(re)) {
            const nome = m[1];
            if (!nome || (exigeMaiuscula && !RE_INICIAL_MAIUSCULA.test(nome))) continue;
            const inicio = m.index + m[0].length - nome.length;
            achados.push({
              tipo: 'nome',
              inicio,
              fim: inicio + nome.length,
              valor: nome,
              detector: 'gatilho',
            });
          }
        }
      }
      // mesmo span achado por duas vias (dicionário + gatilho) conta uma vez
      const vistos = new Set<string>();
      return achados.filter((d) => {
        const chave = `${d.inicio}:${d.fim}`;
        if (vistos.has(chave)) return false;
        vistos.add(chave);
        return true;
      });
    },
  };
}
