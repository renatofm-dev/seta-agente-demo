import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createOpenAICompatibleProvider } from '@seta/ai-provider';
import { newTraceId } from '@seta/observability';
import { chunkMarkdown, tituloDoMarkdown } from '@seta/rag';
import { and, eq } from 'drizzle-orm';
import { createDb, type Db } from './db/index.js';
import { chunk as chunkTable, documento } from './db/schema.js';
import { loadEnv } from './env.js';
import { createPgVectorStore } from './rag/pgvector-store.js';

/**
 * Ingestão da KB (008): `pnpm kb:ingest [dir]`. Chunking por heading,
 * re-ingestão incremental por hash sha256 — arquivo inalterado não re-embeda.
 */

export interface IngestDeps {
  readonly db: Db;
  /** Dimensão dos embeddings — o store é criado POR TRANSAÇÃO (#32). */
  readonly dim: number;
  /** Embeddings em batch; null ⇒ ingere só para busca lexical (com aviso). */
  readonly embed: ((textos: readonly string[]) => Promise<number[][]>) | null;
  readonly dir: string;
  readonly log?: (msg: string) => void;
}

export interface IngestResultado {
  arquivos: number;
  inalterados: number;
  reingeridos: number;
  chunks: number;
}

export async function ingestKb(deps: IngestDeps): Promise<IngestResultado> {
  const { db, dir } = deps;
  const log = deps.log ?? (() => {});
  const resultado: IngestResultado = { arquivos: 0, inalterados: 0, reingeridos: 0, chunks: 0 };

  const arquivos = readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort();
  for (const arquivo of arquivos) {
    resultado.arquivos += 1;
    const conteudo = readFileSync(join(dir, arquivo), 'utf-8');
    const hash = createHash('sha256').update(conteudo).digest('hex');
    const fonte = arquivo; // path relativo ao dir da KB

    const [existente] = await db
      .select()
      .from(documento)
      .where(and(eq(documento.ns, 'kb'), eq(documento.fonte, fonte)))
      .limit(1);
    if (existente?.hash === hash) {
      resultado.inalterados += 1;
      continue; // hash igual ⇒ nada a re-embedar
    }

    const titulo = tituloDoMarkdown(conteudo) ?? arquivo.replace(/\.md$/, '');
    const pedacos = chunkMarkdown(conteudo);
    const embeddings = deps.embed ? await deps.embed(pedacos.map((p) => p.texto)) : null;

    const documentoId = existente?.id ?? newTraceId();
    // #32: mutação do arquivo é ATÔMICA — crash não deixa mais doc com hash
    // novo e zero chunks (irreparável pelo skip de hash) nem chunks órfãos.
    // Embeddings (rede) já foram computados FORA da transação.
    await db.transaction(async (tx) => {
      const storeTx = createPgVectorStore({ db: tx as unknown as Db, dim: deps.dim });
      if (existente) {
        // versão nova: remove chunks antigos (cascade não ajuda — doc é o mesmo)
        await tx.delete(chunkTable).where(eq(chunkTable.documentoId, documentoId));
        await tx
          .update(documento)
          .set({ hash, titulo, versao: existente.versao + 1, atualizadoEm: new Date() })
          .where(eq(documento.id, documentoId));
      } else {
        await tx.insert(documento).values({ id: documentoId, ns: 'kb', fonte, titulo, hash });
      }

      await storeTx.upsert(
        'kb',
        pedacos.map((p, i) => ({
          id: newTraceId(),
          texto: p.texto,
          fonte,
          titulo,
          metadados: (p.heading ? { heading: p.heading } : {}) as Record<string, string>,
          embedding: embeddings?.[i] ?? null,
        })),
      );
      // amarra os chunks ao documento (store não conhece a tabela documento)
      await tx
        .update(chunkTable)
        .set({ documentoId })
        .where(and(eq(chunkTable.ns, 'kb'), eq(chunkTable.fonte, fonte)));
    });
    resultado.reingeridos += 1;
    resultado.chunks += pedacos.length;
    log(`${fonte}: ${pedacos.length} chunks (${existente ? 'atualizado' : 'novo'})`);
  }
  return resultado;
}

async function main(): Promise<void> {
  const env = loadEnv();
  const raiz = join(import.meta.dirname, '../../..');
  const dirArg = process.argv[2] ?? env.KB_DIR;
  const dir = isAbsolute(dirArg) ? dirArg : resolve(raiz, dirArg);

  const provider =
    env.LLM_BASE_URL && env.LLM_API_KEY && env.LLM_MODEL && env.EMBEDDING_MODEL
      ? createOpenAICompatibleProvider({
          baseUrl: env.LLM_BASE_URL,
          apiKey: env.LLM_API_KEY,
          model: env.LLM_MODEL,
          embeddingModel: env.EMBEDDING_MODEL,
        })
      : null;
  if (!provider) {
    console.warn('EMBEDDING_MODEL/LLM_* ausentes — ingerindo só para busca lexical');
  }

  const { db, close } = createDb(env.DATABASE_URL);
  const store = createPgVectorStore({ db, dim: env.EMBEDDING_DIM });
  await store.ensureIndex();
  try {
    const r = await ingestKb({
      db,
      dim: env.EMBEDDING_DIM,
      dir,
      embed: provider
        ? (textos) => provider.embed(textos).then((vs) => vs.map((v) => Array.from(v)))
        : null,
      log: (m) => console.log(m),
    });
    console.log(
      `kb:ingest — ${r.arquivos} arquivos, ${r.inalterados} inalterados, ` +
        `${r.reingeridos} (re)ingeridos, ${r.chunks} chunks gravados`,
    );
  } finally {
    await close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
