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

export interface WaGateway {
  sendText(msg: OutboundText): Promise<{ messageId: string }>;
}
