import type { ToolSpec } from '@seta/query-catalog';
import { z } from 'zod';

/**
 * Tools internas do runtime (mesmo contrato ToolSpec do catálogo).
 * `escalar_para_humano` é interceptada pelo grafo (seta o estado); o retorno é só ack.
 * `buscar_conhecimento` (008) é construída no server — o nome vive aqui porque
 * o prompt-base referencia a tool sem o agent depender de @seta/rag.
 */

export const NOME_ESCALAR = 'escalar_para_humano';
export const NOME_BUSCAR_CONHECIMENTO = 'buscar_conhecimento';

export function toolEscalarParaHumano(): ToolSpec {
  return {
    name: NOME_ESCALAR,
    entryId: 'interno.escalar_para_humano',
    description:
      'Transfere o atendimento para um atendente humano. Use para: pedido de desconto ou ' +
      'negociação de preço, reclamação séria, assunto fora do seu escopo, ou quando o ' +
      'cliente pedir para falar com uma pessoa. Informe o motivo resumido.',
    schema: z.object({
      motivo: z.string().min(3).max(200).describe('Motivo resumido da escalada.'),
    }),
    priceSource: false,
    async execute() {
      return { rows: [{ ok: true }], rowCount: 1, truncated: false };
    },
  };
}
