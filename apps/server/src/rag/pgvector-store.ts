import type { Hit, Ns, SearchFilter, VectorItem, VectorStore } from '@seta/rag';
import { fuseRrf, VectorItemSchema } from '@seta/rag';
import { inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { chunk } from '../db/schema.js';

/**
 * Impl pgvector do port VectorStore (008). Denso = cosseno sobre cast
 * `embedding::vector(D)`; lexical = tsvector 'portuguese' + websearch;
 * hybrid = fusão RRF dos dois rankings em JS.
 */

export interface PgVectorStoreDeps {
  readonly db: Db;
  /** Dimensão dos embeddings (env EMBEDDING_DIM) — valida upsert e parametriza o índice. */
  readonly dim: number;
}

/** Candidatos por ranking antes da fusão (folga sobre k para o RRF trabalhar). */
const CANDIDATOS = 20;

interface LinhaHit {
  id: string;
  texto: string;
  fonte: string;
  titulo: string | null;
  metadados: Record<string, string>;
  score: number;
}

export function createPgVectorStore(deps: PgVectorStoreDeps): VectorStore & {
  ensureIndex(): Promise<void>;
} {
  const { db, dim } = deps;
  if (!Number.isInteger(dim) || dim <= 0) throw new Error(`EMBEDDING_DIM inválida: ${dim}`);
  // dim é int validado (Zod no env + guarda acima), nunca entrada de usuário:
  // typmod de cast/índice não aceita bind — única interpolação permitida aqui.
  const castDim = sql.raw(`vector(${dim})`);

  const paraHit = (r: LinhaHit): Hit => ({
    id: r.id,
    texto: r.texto,
    fonte: r.fonte,
    titulo: r.titulo,
    metadados: r.metadados,
    score: r.score,
  });

  const buscaDensa = async (
    ns: Ns,
    query: readonly number[],
    k: number,
    filter?: SearchFilter,
  ): Promise<Hit[]> => {
    if (query.length === 0) return [];
    if (query.length !== dim) {
      throw new Error(`query com ${query.length} dims; esperado ${dim} (EMBEDDING_DIM)`);
    }
    const vec = `[${query.join(',')}]`;
    const filtroFontes = filter?.fontes?.length
      ? sql` AND fonte IN (${sql.join(
          filter.fontes.map((f) => sql`${f}`),
          sql`, `,
        )})`
      : sql``;
    const r = await db.execute(sql`
      SELECT id, texto, fonte, titulo, metadados,
             1 - ((embedding::${castDim}) <=> ${vec}::${castDim}) AS score
      FROM chunk
      WHERE ns = ${ns} AND embedding IS NOT NULL${filtroFontes}
      ORDER BY (embedding::${castDim}) <=> ${vec}::${castDim}
      LIMIT ${k}
    `);
    return (r.rows as unknown as LinhaHit[]).map((row) =>
      paraHit({ ...row, score: Number(row.score) }),
    );
  };

  const buscaLexical = async (ns: Ns, texto: string, k: number): Promise<Hit[]> => {
    if (texto.trim().length === 0) return [];
    const r = await db.execute(sql`
      SELECT id, texto, fonte, titulo, metadados,
             ts_rank(tsv, websearch_to_tsquery('portuguese', ${texto})) AS score
      FROM chunk
      WHERE ns = ${ns} AND tsv @@ websearch_to_tsquery('portuguese', ${texto})
      ORDER BY score DESC
      LIMIT ${k}
    `);
    return (r.rows as unknown as LinhaHit[]).map((row) =>
      paraHit({ ...row, score: Number(row.score) }),
    );
  };

  return {
    async ensureIndex() {
      // índice de expressão: dimensão vem do env, a migration é estática.
      // Dim divergente (ex.: dev 1536 × testes 8) quebraria o cast do índice
      // em inserts — reconcilia dropando e recriando com a dim corrente.
      const r = await db.execute(
        sql`SELECT indexdef FROM pg_indexes WHERE indexname = 'chunk_embedding_hnsw'`,
      );
      const def = (r.rows[0] as { indexdef?: string } | undefined)?.indexdef;
      if (def?.includes(`vector(${dim})`)) return;
      if (def) await db.execute(sql.raw('DROP INDEX chunk_embedding_hnsw'));
      await db.execute(
        sql.raw(
          `CREATE INDEX chunk_embedding_hnsw ON chunk ` +
            `USING hnsw ((embedding::vector(${dim})) vector_cosine_ops)`,
        ),
      );
    },

    async upsert(ns, items) {
      if (items.length === 0) return;
      for (const item of items) {
        const parsed = VectorItemSchema.parse(item);
        if (parsed.embedding && parsed.embedding.length !== dim) {
          throw new Error(
            `embedding de ${parsed.fonte} com ${parsed.embedding.length} dims; esperado ${dim}`,
          );
        }
      }
      await db
        .insert(chunk)
        .values(
          items.map((i: VectorItem) => ({
            id: i.id,
            ns,
            fonte: i.fonte,
            titulo: i.titulo ?? null,
            texto: i.texto,
            metadados: i.metadados ?? {},
            embedding: i.embedding ? [...i.embedding] : null,
          })),
        )
        .onConflictDoUpdate({
          target: chunk.id,
          set: {
            fonte: sql`excluded.fonte`,
            titulo: sql`excluded.titulo`,
            texto: sql`excluded.texto`,
            metadados: sql`excluded.metadados`,
            embedding: sql`excluded.embedding`,
          },
        });
    },

    async delete(ns, ids) {
      if (ids.length === 0) return;
      await db.delete(chunk).where(inArray(chunk.id, [...ids]));
      void ns; // ids são PK — ns fica na assinatura por clareza do port
    },

    search: (ns, query, k, filter) => buscaDensa(ns, query, k, filter),

    async hybrid(ns, texto, query, k) {
      const [densos, lexicais] = await Promise.all([
        buscaDensa(ns, query, CANDIDATOS),
        buscaLexical(ns, texto, CANDIDATOS),
      ]);
      return fuseRrf([densos, lexicais], k);
    },
  };
}
