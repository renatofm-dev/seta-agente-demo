import type { ErpWriter } from '@seta/erp-api-tse';
import type { ToolSpec } from '@seta/query-catalog';
import { z } from 'zod';
import type { ReservaRepo } from './repo.js';

/**
 * Tools de LEITURA da reserva (038), escritas no server — não no catálogo.
 *
 * Por que não YAML: `validate-sql.ts` só aceita `SELECT` sobre as 7 views
 * canônicas do espelho, e reserva não existe lá (levantamento da 012). O dado
 * vem da API do TSE, então é `ToolSpec` de server, no molde de
 * `pagamentos/tool-cobranca-em-aberto.ts`.
 *
 * **Restrição dura do guardrail de preço** (`guardrails/preco.ts`): todo valor
 * em R$ que o agente citar precisa existir, em CENTAVOS INTEIROS, numa coluna
 * cujo nome case `/centavos|valor|pre[cç]o|total/i`. Daí
 * `taxa_manutencao_centavos` e `valor_total_centavos`. Pontos não são dinheiro
 * e por isso `custo_pontos` é seguro com esse nome.
 */

export const NOME_HOTEIS_DISPONIVEIS = 'hoteis_disponiveis';
export const NOME_MINHAS_RESERVAS = 'minhas_reservas';

export function toolHoteisDisponiveis(writer: ErpWriter): ToolSpec {
  return {
    name: NOME_HOTEIS_DISPONIVEIS,
    entryId: 'interno.hoteis_disponiveis',
    description:
      'Hotéis e torres em que o contrato do cliente pode ser utilizado, com o tipo de unidade ' +
      'de cada um. Use quando o cliente perguntar ONDE pode ficar ou que tipos de unidade ' +
      'existem. Para RESERVAR de fato, use iniciar_reserva.',
    schema: z.object({}),
    priceSource: false,
    async execute(_params, session) {
      if (!session.clienteId) throw new Error('sessão sem vínculo — tool indisponível');
      const hoteis = await writer.listarHoteis(session.clienteId);
      const rows = await Promise.all(
        hoteis.map(async (h) => ({
          hotel_id: h.id,
          hotel: h.descricao,
          tipos_unidade: (await writer.listarTiposUh(h.id)).map((t) => t.descricao).join(', '),
        })),
      );
      return { rows, rowCount: rows.length, truncated: false };
    },
  };
}

const STATUS_HUMANO: Record<string, string> = {
  aguardando_aprovacao: 'aguardando aprovação de um atendente',
  criando: 'sendo registrada',
  criada: 'registrada, aguardando confirmação',
  confirmada: 'confirmada',
  falha: 'com problema — um atendente está vendo',
  cancelada: 'cancelada',
  recusada: 'recusada',
};

export function toolMinhasReservas(repo: ReservaRepo): ToolSpec {
  return {
    name: NOME_MINHAS_RESERVAS,
    entryId: 'interno.minhas_reservas',
    description:
      'Reservas que o cliente já pediu por aqui, da mais recente para a mais antiga: período, ' +
      'hotel, tipo de unidade, situação, pontos e taxa de manutenção. Use quando o cliente ' +
      'perguntar sobre uma reserva que ELE já fez. Lista vazia = nenhuma reserva registrada.',
    schema: z.object({}),
    priceSource: false,
    async execute(_params, session) {
      if (!session.clienteId) throw new Error('sessão sem vínculo — tool indisponível');
      const linhas = await repo.reservasDoContrato(session.clienteId, 10);
      const rows = linhas.map((r) => ({
        reserva_id: r.id,
        check_in: r.checkIn,
        check_out: r.checkOut,
        hotel: r.hotel ?? '',
        tipo_unidade: r.tipoUh ?? '',
        situacao: STATUS_HUMANO[r.status] ?? r.status,
        custo_pontos: r.custoPontos,
        taxa_manutencao_centavos: r.taxaCentavos,
        numero_no_erp: r.erpUtilizacaoId ?? '',
      }));
      return { rows, rowCount: rows.length, truncated: false };
    },
  };
}
