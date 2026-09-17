import { z } from 'zod';
import { WaPhoneSchema } from './template.js';

/**
 * Esqueleto do gateway WhatsApp (Meta Cloud API). Webhook e envio chegam na spec 004.
 */

export { WaPhoneSchema };

export const OutboundTextSchema = z.object({
  to: WaPhoneSchema,
  body: z.string().min(1).max(4096),
});
export type OutboundText = z.infer<typeof OutboundTextSchema>;

/**
 * 040: mensagem de DOCUMENTO. Carrega os bytes, não uma URL — o PDF de boleto
 * é dado pessoal, e uma URL assinada seria um endereço público (ainda que de
 * vida curta) para o nome, o CPF e o valor de alguém. Quem envia faz upload na
 * Meta e manda o `media_id`; nada fica endereçável do nosso lado.
 *
 * `caption` tem teto de 1024 na Cloud API — menor que o de texto livre.
 */
export const OutboundDocumentSchema = z.object({
  to: WaPhoneSchema,
  /**
   * `z.custom` e não `z.instanceof`: este último infere `Uint8Array<ArrayBuffer>`
   * no Zod v4, e `Uint8Array` cru (o que `arrayBuffer()` devolve) não cabe nesse
   * tipo mais estreito.
   */
  bytes: z.custom<Uint8Array>((v) => v instanceof Uint8Array && v.length > 0, 'documento vazio'),
  mime: z.string().min(1).max(120),
  /** O nome que o cotista vê no WhatsApp — legível, com extensão. */
  filename: z.string().min(1).max(240),
  caption: z.string().max(1024).optional(),
});
export type OutboundDocument = z.infer<typeof OutboundDocumentSchema>;

export {
  createLogGateway,
  createMetaGateway,
  JanelaFechadaError,
  type JanelaInfo,
  type LogGatewayLogger,
  type MetaGatewayConfig,
  type OutboundGateway,
} from './gateway.js';
export {
  type BotaoTemplate,
  BotaoTemplateSchema,
  type ItemPedido,
  ItemPedidoSchema,
  type OrderDetails,
  OrderDetailsSchema,
  PIX_KEY_TYPES,
  type PixKeyType,
} from './order-details.js';
export {
  type InboundText,
  parseInboundTexts,
  parseStatuses,
  type StatusUpdate,
  type WebhookPayload,
  WebhookPayloadSchema,
} from './payload.js';
export { signBody, verifySignature } from './signature.js';
export {
  createMetaTemplateApi,
  type MetaTemplateApiConfig,
  type OutboundTemplate,
  OutboundTemplateSchema,
  payloadDeTemplate,
  TEMPLATE_CATEGORIAS,
  TEMPLATE_STATUS,
  type TemplateApi,
  type TemplateCategoria,
  type TemplateDef,
  TemplateDefSchema,
  type TemplateRemoto,
  type TemplateStatus,
  variaveisDoCorpo,
} from './template.js';
