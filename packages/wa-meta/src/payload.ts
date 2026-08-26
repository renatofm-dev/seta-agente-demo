import { z } from 'zod';

/**
 * Parse do payload de webhook da Meta Cloud API (v21+). A POC trata apenas
 * mensagens de texto; outros tipos são ignorados com aviso no caller.
 */

const TextMessageSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  timestamp: z.string().regex(/^\d+$/),
  type: z.string(),
  text: z.object({ body: z.string() }).optional(),
});

const StatusSchema = z.object({
  id: z.string().min(1),
  status: z.enum(['sent', 'delivered', 'read', 'failed']),
  recipient_id: z.string().optional(),
});

const ChangeValueSchema = z.object({
  messaging_product: z.literal('whatsapp').optional(),
  messages: z.array(TextMessageSchema).optional(),
  statuses: z.array(StatusSchema).optional(),
});

export const WebhookPayloadSchema = z.object({
  object: z.string(),
  entry: z.array(
    z.object({
      id: z.string().optional(),
      changes: z.array(z.object({ field: z.string().optional(), value: ChangeValueSchema })),
    }),
  ),
});
export type WebhookPayload = z.infer<typeof WebhookPayloadSchema>;

export interface InboundText {
  readonly waId: string;
  readonly waMessageId: string;
  readonly texto: string;
  readonly timestamp: Date;
}

export interface StatusUpdate {
  readonly waMessageId: string;
  readonly status: 'sent' | 'delivered' | 'read' | 'failed';
}

/** Mensagens de texto do payload (tipos não-texto ficam de fora). */
export function parseInboundTexts(payload: WebhookPayload): InboundText[] {
  const out: InboundText[] = [];
  for (const entry of payload.entry) {
    for (const change of entry.changes) {
      for (const msg of change.value.messages ?? []) {
        if (msg.type !== 'text' || !msg.text) continue;
        out.push({
          waId: msg.from,
          waMessageId: msg.id,
          texto: msg.text.body,
          timestamp: new Date(Number(msg.timestamp) * 1000),
        });
      }
    }
  }
  return out;
}

export function parseStatuses(payload: WebhookPayload): StatusUpdate[] {
  const out: StatusUpdate[] = [];
  for (const entry of payload.entry) {
    for (const change of entry.changes) {
      for (const st of change.value.statuses ?? []) {
        out.push({ waMessageId: st.id, status: st.status });
      }
    }
  }
  return out;
}
