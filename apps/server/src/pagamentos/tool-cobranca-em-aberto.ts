import { NOME_METODO } from '@seta/cobranca';
import type { ToolSpec } from '@seta/query-catalog';
import { z } from 'zod';
import type { PagamentosRepo } from './repo.js';

/**
 * Tool de LEITURA para o agente geral: a última cobrança gerada pelo fluxo de
 * pagamento do contrato da sessão. Serve para reenviar link/código e responder
 * "já foi confirmado?". A coluna `valor_centavos` é o que legitima o valor no
 * guardrail de preço (006) — sem ela o agente escalaria ao repetir o valor.
 */

export const NOME_COBRANCA_EM_ABERTO = 'cobranca_em_aberto';

const STATUS_HUMANO: Record<string, string> = {
  aguardando_aprovacao: 'aguardando aprovação de um atendente',
  emitindo: 'sendo gerada',
  emitida: 'gerada, aguardando pagamento',
  paga: 'paga (pagamento confirmado)',
  expirada: 'expirada (vencida sem pagamento)',
  cancelada: 'cancelada',
  recusada: 'não liberada por um atendente',
  falha: 'falhou ao gerar',
  estornada: 'estornada',
};

export function toolCobrancaEmAberto(repo: PagamentosRepo): ToolSpec {
  return {
    name: NOME_COBRANCA_EM_ABERTO,
    entryId: 'interno.cobranca_em_aberto',
    description:
      'Últimas cobranças geradas pelo fluxo de pagamento para o contrato da sessão: situação, ' +
      'forma (boleto|PIX|cartão), valor em centavos, vencimento, link de pagamento, linha ' +
      'digitável ou código PIX e as parcelas cobertas. Use quando o cliente pedir para ' +
      'reenviar o link/código ou perguntar se o pagamento já foi confirmado. Vazio = nenhuma ' +
      'cobrança gerada. Para gerar uma nova, use iniciar_pagamento.',
    schema: z.object({}),
    priceSource: false,
    async execute(_params, session) {
      if (!session.clienteId) throw new Error('sessão sem vínculo — tool indisponível');
      const cobrancas = await repo.cobrancasRecentesDoContrato(session.clienteId, 3);
      const rows = await Promise.all(
        cobrancas.map(async (c) => {
          const titulos = await repo.titulosDe(c.id);
          return {
            situacao: STATUS_HUMANO[c.status] ?? c.status,
            forma: NOME_METODO[c.metodo],
            valor_centavos: c.valorCentavos,
            vencimento: c.vencimentoPsp,
            url_pagamento: c.urlBoleto ?? c.urlFatura,
            linha_digitavel: c.linhaDigitavel,
            pix_copia_cola: c.pixCopiaCola,
            parcelas: titulos
              .map(
                (t) =>
                  `parcela ${t.parcela}${t.totalParcelas ? `/${t.totalParcelas}` : ''} (${t.origem})`,
              )
              .join(', '),
            gerada_em: c.criadoEm.toISOString(),
            paga_em: c.pagoEm?.toISOString() ?? null,
          };
        }),
      );
      return { rows, rowCount: rows.length, truncated: false };
    },
  };
}
