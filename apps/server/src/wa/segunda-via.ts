import { formatarReais } from '@seta/cobranca';
import type { Executor, SessionCtx, ToolSpec } from '@seta/query-catalog';
import { z } from 'zod';
import { isoDia } from '../pagamentos/candidatos.js';
import type { AnexoDaLinha } from './outbox.js';

/**
 * 040 — a 2ª via de boleto em PDF.
 *
 * O desenho tem um formato só, e ele vem de uma regra: **o PDF nunca passa
 * pelo modelo**. A tool só verifica e SINALIZA; quem entrega é o servidor,
 * depois que a frase do agente saiu — o mesmo contrato de `iniciar_pagamento`.
 *
 * A verificação não é burocracia. O `titulo_id` é o único parâmetro que vem do
 * modelo em todo este caminho, e ele decide QUAL boleto sai. Por isso a
 * consulta que valida (`financeiro.boleto_da_parcela`) tem o contrato como bind
 * de SESSÃO: pedir a parcela de outro contrato não devolve linha nenhuma, e o
 * resto do fluxo nem começa. O modelo escolhe entre o que já leu; ele não
 * alcança o que não é do cotista da conversa.
 */

export const NOME_SEGUNDA_VIA = 'enviar_segunda_via';

/** O que o servidor precisa para entregar, depois que o turno responder. */
export interface PedidoSegundaVia {
  readonly anexo: AnexoDaLinha;
  /** Legenda do documento — vira o texto da mensagem no console e no histórico. */
  readonly legenda: string;
}

const ParamsSchema = z.object({
  titulo_id: z
    .string()
    .min(1)
    .max(40)
    .describe('Id da parcela, exatamente como veio de titulos_atraso ou proximas_parcelas.'),
});

/** Como o cotista reconhece a parcela numa frase. */
function rotulo(parcela: unknown, total: unknown): string {
  const n = String(parcela ?? '').trim();
  const t = String(total ?? '').trim();
  if (!n) return 'parcela';
  return t ? `parcela ${n}/${t}` : `parcela ${n}`;
}

/**
 * O vencimento chega do pg como `Date`, não como string — `String(date)` daria
 * "Tue Mar 10 2026" e o `slice(0,10)` picaria isso em pedaços sem sentido.
 * `isoDia` (014) é quem normaliza as duas formas sem deslocar o dia por fuso.
 */
function dataBr(valor: unknown): string {
  const [a, m, d] = isoDia(valor).split('-');
  return d && m && a ? `${d}/${m}/${a}` : isoDia(valor);
}

/**
 * `formatarReais` da 014, e não `toLocaleString`: com `style: 'currency'` o ICU
 * mete um espaço NÃO-QUEBRÁVEL entre `R$` e o número, e esta legenda vai para o
 * WhatsApp. `valor_centavos` é `bigint` no Postgres e chega como string.
 */
function reais(centavos: unknown): string {
  const n = typeof centavos === 'number' ? centavos : Number(centavos);
  return Number.isFinite(n) ? formatarReais(Math.round(n)) : '';
}

/**
 * Nome do arquivo no WhatsApp. Só `[a-z0-9-]`: o nome atravessa multipart para
 * a Meta e aparece na tela do cotista — acento e espaço não ajudam em nenhum
 * dos dois lados, e o vencimento é o que diferencia dois boletos na lista de
 * arquivos de quem tem várias parcelas.
 */
export function nomeDoArquivo(parcela: unknown, vencimento: unknown): string {
  const n = String(parcela ?? '').replace(/\D/g, '') || '0';
  const venc = isoDia(vencimento).replace(/\D/g, '');
  return `boleto-parcela-${n.padStart(2, '0')}${venc.length === 8 ? `-${venc}` : ''}.pdf`;
}

/**
 * Por que a parcela não tem boleto. Dizer "não tem" e parar deixaria o agente
 * inventando o motivo; com a forma de pagamento na mão ele explica o que é.
 */
const SEM_BOLETO: Record<string, string> = {
  pix: 'essa parcela é paga por PIX, não tem boleto emitido',
  cartao_recorrente: 'essa parcela é cobrada no cartão recorrente, não tem boleto emitido',
};

export interface SegundaViaDeps {
  readonly executor: Executor;
  readonly session: SessionCtx;
}

/**
 * `registrar` é o canal de volta para o turno: a tool não envia nada, ela
 * anota. O turno-handler decide se entrega — e só entrega se a frase do agente
 * tiver realmente saído (turno fundido ou descartado não manda boleto nenhum).
 */
export function toolEnviarSegundaVia(
  deps: SegundaViaDeps,
  registrar: (p: PedidoSegundaVia) => void,
): ToolSpec {
  return {
    name: NOME_SEGUNDA_VIA,
    entryId: 'interno.enviar_segunda_via',
    description:
      'Envia ao cliente, em PDF pelo WhatsApp, a 2ª via do boleto de UMA parcela do contrato ' +
      'dele. Use quando o cliente pedir o boleto, a segunda via, o PDF ou o documento de uma ' +
      'parcela. Informe o titulo_id da parcela, exatamente como ele apareceu em titulos_atraso ' +
      'ou proximas_parcelas — se você ainda não listou as parcelas, liste antes e pergunte qual ' +
      'ele quer. Depois de chamar, responda em UMA frase curta que o boleto está indo; o ' +
      'arquivo sai logo em seguida, você não precisa (nem consegue) anexá-lo. Parcela sem ' +
      'boleto ou de outro contrato volta com ok=false e o motivo: explique, não tente de novo.',
    schema: ParamsSchema,
    priceSource: false,
    async execute(params, session) {
      if (!session.clienteId) throw new Error('sessão sem vínculo — tool indisponível');
      const { titulo_id } = ParamsSchema.parse(params);
      const r = await deps.executor.run(
        'financeiro.boleto_da_parcela',
        { titulo_id },
        deps.session,
      );
      const linha = r.rows[0];
      if (!linha) {
        return {
          rows: [
            {
              ok: false,
              motivo:
                'não encontrei essa parcela no contrato deste cliente; liste as parcelas de novo e confirme com ele qual é',
            },
          ],
          rowCount: 1,
          truncated: false,
        };
      }
      if (linha.linha_digitavel == null) {
        const meio = String(linha.meio_pagamento ?? '');
        return {
          rows: [
            {
              ok: false,
              parcela: rotulo(linha.parcela, linha.total_parcelas),
              motivo: SEM_BOLETO[meio] ?? 'não há boleto gerado para essa parcela',
            },
          ],
          rowCount: 1,
          truncated: false,
        };
      }

      const qual = rotulo(linha.parcela, linha.total_parcelas);
      const valor = reais(linha.valor_centavos);
      registrar({
        anexo: {
          tipo: 'segunda_via',
          contaFinanceiraId: String(linha.id),
          filename: nomeDoArquivo(linha.parcela, linha.vencimento),
        },
        legenda:
          `Segue a 2ª via da ${qual}` +
          `${valor ? `, no valor de ${valor}` : ''}` +
          `, com vencimento em ${dataBr(linha.vencimento)}.`,
      });
      return {
        rows: [
          {
            ok: true,
            parcela: qual,
            vencimento: linha.vencimento,
            instrucao:
              'boleto a caminho; responda em uma frase curta que está enviando o PDF, sem repetir valor nem vencimento',
          },
        ],
        rowCount: 1,
        truncated: false,
      };
    },
  };
}
