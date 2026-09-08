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
