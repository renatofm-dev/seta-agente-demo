import { descricaoParcela } from '@seta/cobranca';
import type { BotaoTemplate } from '@seta/wa-meta';
import type { CobrancaRow, CobrancaTituloRow } from './repo.js';

/**
 * Traduz uma cobrança emitida no pedido que vai no botão do template (043).
 *
 * Função pura: não fala com banco nem com PSP — tudo que precisa já está na
 * linha da cobrança desde a 042 (`pix_copia_cola`, `valor_centavos`).
 *
 * Devolve `null` em vez de lançar, pelo mesmo princípio de `notificarPago`:
 * o canal de aviso nunca derruba a emissão. Quem recebe `null` cai no caminho
 * de texto da 014, que continua intacto.
 */

/** Recebedor do PIX, de `client.yaml` (`pagamentos.pix`). */
export interface PixRecebedor {
  readonly merchantName: string;
  readonly key: string;
  readonly keyType: 'CPF' | 'CNPJ' | 'EMAIL' | 'PHONE' | 'EVP';
}

type CobrancaParaPedido = Pick<
  CobrancaRow,
  'id' | 'contratoId' | 'metodo' | 'valorCentavos' | 'pixCopiaCola'
>;

/** Nome de item do pedido — a Meta trunca nomes longos sem avisar. */
const MAX_NOME_ITEM = 60;

export function montarBotaoPix(
  cobranca: CobrancaParaPedido,
  titulos: readonly CobrancaTituloRow[],
  recebedor: PixRecebedor | null,
): BotaoTemplate | null {
  // boleto e cartão não são pagáveis dentro do WhatsApp — oferecer o botão
  // seria mentira para o cotista.
  if (cobranca.metodo !== 'pix') return null;
  if (!cobranca.pixCopiaCola) return null;
  if (!recebedor) return null;
  if (titulos.length === 0) return null;

  const soma = titulos.reduce((s, t) => s + t.valorCentavos, 0);
  // Juros/multa fariam a soma divergir do total, e a Meta recusa isso com erro
  // opaco. Colapsar num item só é determinístico e nunca é recusado.
  const itens =
    soma === cobranca.valorCentavos
      ? titulos.map((t) => ({
          retailerId: t.tituloId,
          nome: descricaoParcela({
            tituloId: t.tituloId,
            origem: t.origem,
            parcela: t.parcela,
            totalParcelas: t.totalParcelas,
            valorCentavos: t.valorCentavos,
            vencimento: t.vencimento,
            situacao: 'vencida',
          }).slice(0, MAX_NOME_ITEM),
          valorCentavos: t.valorCentavos,
          quantidade: 1,
        }))
      : [
          {
            retailerId: cobranca.id,
            nome: `Parcelas do contrato ${cobranca.contratoId}`.slice(0, MAX_NOME_ITEM),
            valorCentavos: cobranca.valorCentavos,
            quantidade: 1,
          },
        ];

  return {
    tipo: 'order_details',
    indice: 0,
    orderDetails: {
      // `cobranca.id` é UUIDv7. A sonda de 15/09/2026 confirmou que a Meta
      // aceita `reference_id` repetido, então reenvio não precisa de sufixo.
      referenceId: cobranca.id,
      tipo: 'digital-goods',
      totalCentavos: cobranca.valorCentavos,
      taxaCentavos: 0,
      itens,
      pix: {
        code: cobranca.pixCopiaCola,
        merchantName: recebedor.merchantName,
        key: recebedor.key,
        keyType: recebedor.keyType,
      },
    },
  };
}
