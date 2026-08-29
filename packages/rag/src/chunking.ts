/**
 * Chunking de markdown por heading, alvo ~500 tokens (~4 chars/token) com
 * overlap curto. Puro e determinístico — testável sem banco/provider.
 */

export interface ChunkOpts {
  /** Tamanho-alvo do chunk em caracteres (~500 tokens ≈ 2000 chars). */
  readonly alvoChars?: number;
  /** Overlap entre chunks consecutivos de uma mesma seção longa. */
  readonly overlapChars?: number;
}

export interface ChunkDoc {
  readonly seq: number;
  /** Heading da seção de origem ('' quando o texto precede o primeiro heading). */
  readonly heading: string;
  readonly texto: string;
}

interface Secao {
  heading: string;
  linhas: string[];
}

function separarSecoes(md: string): Secao[] {
  const secoes: Secao[] = [{ heading: '', linhas: [] }];
  for (const linha of md.split('\n')) {
    const m = /^(#{1,6})\s+(.+)$/.exec(linha);
    if (m?.[2]) {
      secoes.push({ heading: m[2].trim(), linhas: [linha] });
    } else {
      const atual = secoes.at(-1);
      if (atual) atual.linhas.push(linha);
    }
  }
  return secoes
    .map((s) => ({ heading: s.heading, texto: s.linhas.join('\n').trim() }))
    .filter((s) => s.texto.length > 0)
    .map((s) => ({ heading: s.heading, linhas: [s.texto] }));
}

/** Primeiro H1 do documento (título amigável); null se não houver. */
export function tituloDoMarkdown(md: string): string | null {
  const m = /^#\s+(.+)$/m.exec(md);
  return m?.[1]?.trim() ?? null;
}

function fatiarLongo(texto: string, alvo: number, overlap: number): string[] {
  if (texto.length <= alvo) return [texto];
  const fatias: string[] = [];
  let inicio = 0;
  while (inicio < texto.length) {
    let fim = Math.min(inicio + alvo, texto.length);
    if (fim < texto.length) {
      // corta em fronteira de parágrafo/linha quando possível
      const quebra = texto.lastIndexOf('\n', fim);
      if (quebra > inicio + alvo / 2) fim = quebra;
    }
    fatias.push(texto.slice(inicio, fim).trim());
    if (fim >= texto.length) break;
    inicio = Math.max(fim - overlap, inicio + 1);
  }
  return fatias.filter((f) => f.length > 0);
}

export function chunkMarkdown(md: string, opts: ChunkOpts = {}): ChunkDoc[] {
  const alvo = opts.alvoChars ?? 2000;
  const overlap = opts.overlapChars ?? 200;
  const secoes = separarSecoes(md);

  // agrupa seções pequenas consecutivas até o alvo; fatia as longas com overlap
  const chunks: ChunkDoc[] = [];
  let buffer = '';
  let headingBuffer = '';
  const flush = () => {
    if (buffer.trim().length === 0) return;
    chunks.push({ seq: chunks.length, heading: headingBuffer, texto: buffer.trim() });
    buffer = '';
    headingBuffer = '';
  };
  for (const s of secoes) {
    const texto = s.linhas.join('\n');
    if (texto.length > alvo) {
      flush();
      for (const fatia of fatiarLongo(texto, alvo, overlap)) {
        chunks.push({ seq: chunks.length, heading: s.heading, texto: fatia });
      }
      continue;
    }
    if (buffer.length > 0 && buffer.length + texto.length + 2 > alvo) flush();
    if (buffer.length === 0) headingBuffer = s.heading;
    buffer = buffer.length > 0 ? `${buffer}\n\n${texto}` : texto;
  }
  flush();
  return chunks;
}
