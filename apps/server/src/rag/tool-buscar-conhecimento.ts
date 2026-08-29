import { NOME_BUSCAR_CONHECIMENTO } from '@seta/agent';
import type { ToolSpec } from '@seta/query-catalog';
import type { VectorStore } from '@seta/rag';
import { z } from 'zod';

/**
 * Tool real de RAG (008): busca híbrida top-4 na KB. `fonte` é o título
 * amigável do documento — é o que o agente cita na resposta (nunca path).
 */

export interface ToolBuscarConhecimentoDeps {
  readonly store: VectorStore;
  /** Embedding da pergunta; falha/ausência ⇒ busca só lexical. */
  readonly embed: ((texto: string) => Promise<number[]>) | null;
}

const TOP_K = 4;

export function toolBuscarConhecimento(deps: ToolBuscarConhecimentoDeps): ToolSpec {
  return {
    name: NOME_BUSCAR_CONHECIMENTO,
    entryId: 'interno.buscar_conhecimento',
    description:
      'Busca na base de conhecimento (políticas, prazos de entrega, trocas e devoluções, ' +
      'pagamento e boletos, horários, cadastro). Use para perguntas institucionais que não ' +
      'são sobre dados do cliente. Cite a fonte retornada ao usar um trecho.',
    schema: z.object({
      pergunta: z.string().min(2).max(200).describe('Pergunta ou tema a procurar na base.'),
    }),
    priceSource: false,
    async execute(rawParams) {
      const { pergunta } = z.object({ pergunta: z.string().min(2).max(200) }).parse(rawParams);
      const embedding = deps.embed ? await deps.embed(pergunta).catch(() => []) : [];
      const hits = await deps.store.hybrid('kb', pergunta, embedding, TOP_K);
      return {
        rows: hits.map((h) => ({ trecho: h.texto, fonte: h.titulo ?? h.fonte })),
        rowCount: hits.length,
        truncated: false,
      };
    },
  };
}
