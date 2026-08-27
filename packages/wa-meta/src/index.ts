import { z } from 'zod';

/**
 * Esqueleto do gateway WhatsApp (Meta Cloud API). Webhook e envio chegam na spec 004.
 */

/** Telefone em E.164 sem o `+` (formato usado pela Cloud API no campo `to`). */
export const WaPhoneSchema = z.string().regex(/^[1-9]\d{7,14}$/, 'telefone deve ser E.164 sem +');

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
