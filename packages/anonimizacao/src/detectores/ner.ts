import type { Deteccao, Detector } from '../tipos.js';

/**
 * NER local via @huggingface/transformers (ONNX em Node — sem Python, sem
 * rede depois do primeiro download). Modelo multilíngue com português; só o
 * label PER vira detecção `nome`.
 *
 * Import dinâmico: o package carrega sem o modelo e sem a dependência nativa.
 * Cache LRU por texto: o histórico da conversa se repete a cada turno, então
 * o NER só roda no que é novo. Erro de inferência NUNCA derruba a chamada —
 * perde recall, não disponibilidade (regex + dicionário seguem).
 */

export const MODELO_NER_DEFAULT = 'Xenova/distilbert-base-multilingual-cased-ner-hrl';

export interface NerConfig {
  readonly modelo?: string;
  /** Diretório de cache dos modelos (HF_HOME-like). */
  readonly cacheDir?: string;
  /** Permite baixar do Hugging Face se não estiver no cache (default true). */
  readonly permitirDownload?: boolean;
  /** Score mínimo do token para contar (default 0.6). */
  readonly minScore?: number;
  /** Entradas no cache LRU (default 1000). */
  readonly maxCache?: number;
  /** Tamanho da janela de texto por inferência (default 1500 chars). */
  readonly janelaChars?: number;
  readonly onErro?: (err: unknown) => void;
}

export interface NerDetector extends Detector {
  /** Carrega o modelo; lança se não conseguir (chame no boot e decida). */
  pronto(): Promise<void>;
}

interface TokenNer {
  entity: string;
  score: number;
  word: string;
  start?: number | null;
  end?: number | null;
}

type Pipe = (texto: string, opts?: Record<string, unknown>) => Promise<TokenNer[] | TokenNer[][]>;

/** Quebra por linha em janelas de até `max` chars, com o offset de cada uma. */
export function janelas(texto: string, max: number): { texto: string; offset: number }[] {
  const out: { texto: string; offset: number }[] = [];
  let atual = '';
  let inicioAtual = 0;
  let pos = 0;
  for (const linha of texto.split(/(?<=\n)/)) {
    if (atual.length + linha.length > max && atual.length > 0) {
      out.push({ texto: atual, offset: inicioAtual });
      atual = '';
      inicioAtual = pos;
    }
    // linha maior que a janela: corta em pedaços
    if (linha.length > max) {
      if (atual.length > 0) {
        out.push({ texto: atual, offset: inicioAtual });
        atual = '';
      }
      for (let i = 0; i < linha.length; i += max) {
        out.push({ texto: linha.slice(i, i + max), offset: pos + i });
      }
      pos += linha.length;
      inicioAtual = pos;
      continue;
    }
    if (atual.length === 0) inicioAtual = pos;
    atual += linha;
    pos += linha.length;
  }
  if (atual.length > 0) out.push({ texto: atual, offset: inicioAtual });
  return out;
}

/**
 * Agrupa tokens B-PER/I-PER em spans. Usa start/end quando o pipeline traz;
 * senão localiza a palavra (sem `##`) sequencialmente no texto.
 */
export function agruparPessoas(
  tokens: readonly TokenNer[],
  texto: string,
  minScore: number,
): { inicio: number; fim: number }[] {
  const spans: { inicio: number; fim: number }[] = [];
  let cursor = 0;
  let aberto: { inicio: number; fim: number } | null = null;

  const localizar = (word: string): { inicio: number; fim: number } | null => {
    const limpo = word.startsWith('##') ? word.slice(2) : word;
    if (!limpo) return null;
    const idx = texto.indexOf(limpo, cursor);
    if (idx < 0) return null;
    cursor = idx + limpo.length;
    return { inicio: idx, fim: idx + limpo.length };
  };

  for (const t of tokens) {
    const label = t.entity.replace(/^[BI]-/, '');
    const prefixo = t.entity.startsWith('B-') ? 'B' : t.entity.startsWith('I-') ? 'I' : 'O';
    const pos =
      typeof t.start === 'number' && typeof t.end === 'number' && t.end > t.start
        ? { inicio: t.start, fim: t.end }
        : localizar(t.word);
    if (!pos) continue;
    if (label !== 'PER' || t.score < minScore) {
      if (aberto) spans.push(aberto);
      aberto = null;
      continue;
    }
    const continua =
      aberto && (prefixo === 'I' || t.word.startsWith('##')) && pos.inicio - aberto.fim <= 1;
    if (continua && aberto) {
      aberto = { inicio: aberto.inicio, fim: pos.fim };
    } else {
      if (aberto) spans.push(aberto);
      aberto = { inicio: pos.inicio, fim: pos.fim };
    }
  }
  if (aberto) spans.push(aberto);
  return spans;
}

export function createNerDetector(cfg: NerConfig = {}): NerDetector {
  const modelo = cfg.modelo ?? MODELO_NER_DEFAULT;
  const minScore = cfg.minScore ?? 0.6;
  const maxCache = cfg.maxCache ?? 1000;
  const janelaChars = cfg.janelaChars ?? 1500;
  const cache = new Map<string, readonly Deteccao[]>();
  let pipe: Pipe | null = null;
  let carregando: Promise<void> | null = null;

  async function carregar(): Promise<void> {
    if (pipe) return;
    if (!carregando) {
      carregando = (async () => {
        const tf = (await import('@huggingface/transformers')) as {
          env: { cacheDir?: string; allowRemoteModels?: boolean; allowLocalModels?: boolean };
          pipeline: (
            tarefa: string,
            modelo: string,
            opts?: Record<string, unknown>,
          ) => Promise<Pipe>;
        };
        if (cfg.cacheDir) tf.env.cacheDir = cfg.cacheDir;
        tf.env.allowRemoteModels = cfg.permitirDownload ?? true;
        tf.env.allowLocalModels = true;
        pipe = await tf.pipeline('token-classification', modelo, { dtype: 'q8' });
      })().catch((err) => {
        carregando = null;
        throw err;
      });
    }
    await carregando;
  }

  function lembrar(chave: string, valor: readonly Deteccao[]): void {
    if (cache.size >= maxCache) {
      const primeira = cache.keys().next().value;
      if (primeira !== undefined) cache.delete(primeira);
    }
    cache.set(chave, valor);
  }

  return {
    nome: 'ner',
    pronto: carregar,
    async detectar(texto) {
      if (!texto.trim()) return [];
      const emCache = cache.get(texto);
      if (emCache) {
        cache.delete(texto);
        cache.set(texto, emCache); // LRU: recente vai para o fim
        return emCache;
      }
      try {
        await carregar();
        if (!pipe) return [];
        const achados: Deteccao[] = [];
        for (const j of janelas(texto, janelaChars)) {
          const bruto = await pipe(j.texto, { ignore_labels: [] });
          const tokens = (
            Array.isArray(bruto[0]) ? (bruto as TokenNer[][]).flat() : (bruto as TokenNer[])
          ).filter((t) => t && typeof t.entity === 'string');
          for (const s of agruparPessoas(tokens, j.texto, minScore)) {
            const valor = j.texto.slice(s.inicio, s.fim);
            if (valor.trim().length < 2) continue;
            achados.push({
              tipo: 'nome',
              inicio: j.offset + s.inicio,
              fim: j.offset + s.fim,
              valor,
              detector: 'ner',
            });
          }
        }
        lembrar(texto, achados);
        return achados;
      } catch (err) {
        cfg.onErro?.(err);
        return [];
      }
    },
  };
}
