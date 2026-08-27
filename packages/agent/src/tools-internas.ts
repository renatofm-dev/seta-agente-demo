import type { ToolSpec } from '@seta/query-catalog';
import { z } from 'zod';

/**
 * Tools internas do runtime (mesmo contrato ToolSpec do catálogo).
 * `escalar_para_humano` é interceptada pelo grafo (seta o estado); o retorno é só ack.
 * `buscar_conhecimento` é stub tipado até a spec 008 (RAG).
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

export function toolBuscarConhecimentoStub(): ToolSpec {
  return {
    name: NOME_BUSCAR_CONHECIMENTO,
    entryId: 'interno.buscar_conhecimento',
    description:
      'Busca na base de conhecimento (políticas, prazos de entrega, trocas e devoluções, ' +
      'horários). Use para perguntas institucionais que não são sobre dados do cliente.',
    schema: z.object({
      consulta: z.string().min(2).max(200).describe('O que procurar na base.'),
    }),
    priceSource: false,
    async execute() {
      // RAG chega na spec 008 — retorno vazio honesto (o modelo admite não saber)
      return { rows: [], rowCount: 0, truncated: false };
    },
  };
}
