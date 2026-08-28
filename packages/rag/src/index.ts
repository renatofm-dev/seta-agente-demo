import { z } from 'zod';

/**
 * Port VectorStore (008): retrieval denso + lexical sobre namespaces isolados.
 * ns 'kb' = base de conhecimento (documentos chunkeados); ns 'skills' = skills
 * ativas da 009 (1 item por skill). Implementação pgvector vive no server.
 */

export const NAMESPACES = ['kb', 'skills'] as const;
export const NsSchema = z.enum(NAMESPACES);
export type Ns = z.infer<typeof NsSchema>;

export const VectorItemSchema = z.object({
  id: z.uuid(),
  texto: z.string().min(1),
  /** Identificador estável da origem (path relativo do doc ou idLogico da skill). */
  fonte: z.string().min(1),
  /** Nome amigável exibível ao cliente (nunca path/id interno). */
  titulo: z.string().min(1).optional(),
  metadados: z.record(z.string(), z.string()).default({}),
  /** null ⇒ item participa só da busca lexical (embed indisponível). */
  embedding: z.array(z.number()).min(1).nullable(),
});
export type VectorItem = z.infer<typeof VectorItemSchema>;

export interface Hit {
  readonly id: string;
  readonly texto: string;
  readonly fonte: string;
  readonly titulo: string | null;
  readonly metadados: Record<string, string>;
  readonly score: number;
}

export interface SearchFilter {
  readonly fontes?: readonly string[];
}

export interface VectorStore {
  upsert(ns: Ns, items: readonly VectorItem[]): Promise<void>;
  /** Remoção física — kill-switch da 009 exige sumir do retrieval na hora. */
  delete(ns: Ns, ids: readonly string[]): Promise<void>;
  /** Busca densa (cosseno); query é o embedding do texto de consulta. */
  search(ns: Ns, query: readonly number[], k: number, filter?: SearchFilter): Promise<Hit[]>;
  /** Densa + tsvector com fusão RRF; query vazia ⇒ só lexical. */
  hybrid(ns: Ns, texto: string, query: readonly number[], k: number): Promise<Hit[]>;
}

export { type ChunkDoc, type ChunkOpts, chunkMarkdown, tituloDoMarkdown } from './chunking.js';
export { fuseRrf } from './rrf.js';
