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
/** 014: interceptada pelo grafo — o server inicia o fluxo de cobrança após a resposta. */
export const NOME_INICIAR_PAGAMENTO = 'iniciar_pagamento';

export function toolIniciarPagamento(): ToolSpec {
  return {
    name: NOME_INICIAR_PAGAMENTO,
    entryId: 'interno.iniciar_pagamento',
    description:
      'Inicia o fluxo de pagamento: lista as parcelas em aberto do contrato e conduz o ' +
      'cliente até gerar boleto, PIX ou link de cartão. Use quando o cliente quiser pagar, ' +
      'quitar ou regularizar parcelas, ou pedir boleto/PIX/link PARA PAGAR. Não cite valores ' +
      'nem prometa condições: o fluxo mostra os dados reais logo em seguida. Depois de chamar, ' +
      'responda em UMA frase curta que vai verificar as pendências.',
    schema: z.object({}),
    priceSource: false,
    async execute() {
      return {
        rows: [
          {
            ok: true,
            instrucao:
              'fluxo de pagamento iniciado; responda em uma frase que vai listar as pendências, sem valores',
          },
        ],
        rowCount: 1,
        truncated: false,
      };
    },
  };
}

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
