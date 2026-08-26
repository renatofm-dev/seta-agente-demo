import { z } from 'zod';

/**
 * Port VectorStore: busca semântica sobre a base de conhecimento (kb/).
 * Implementação pgvector e ingestão chegam na spec 008.
 */

export const ChunkSchema = z.object({
  id: z.uuid(),
  texto: z.string().min(1),
  fonte: z.string().min(1),
  metadata: z.record(z.string(), z.string()).default({}),
});
export type Chunk = z.infer<typeof ChunkSchema>;

export interface SearchHit {
  readonly chunk: Chunk;
  readonly score: number;
}

export interface VectorStore {
  upsert(chunks: readonly Chunk[]): Promise<void>;
  search(consulta: string, k: number): Promise<readonly SearchHit[]>;
}
