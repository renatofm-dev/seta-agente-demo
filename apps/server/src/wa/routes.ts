import {
  parseInboundTexts,
  parseStatuses,
  verifySignature,
  WebhookPayloadSchema,
} from '@seta/wa-meta';
import { eq } from 'drizzle-orm';
import type { FastifyPluginCallback } from 'fastify';
import type { PgBoss } from 'pg-boss';
import type { Db } from '../db/index.js';
import { mensagem } from '../db/schema.js';
import type { Env } from '../env.js';
import { processInbound } from './inbound.js';

/**
 * Rotas do webhook Meta. Plugin encapsulado: o parser de corpo BRUTO (necessário
 * para o HMAC) vale só aqui. POST responde 200 sempre — exceto assinatura
 * inválida (401, sem side effects).
 */

export interface WaRoutesOpts {
  readonly env: Env;
  readonly db: Db;
  readonly boss: PgBoss;
}

const STATUS_MAP = {
  sent: 'enviada',
  delivered: 'entregue',
  read: 'lida',
  failed: 'falha',
} as const;

export const waRoutes: FastifyPluginCallback<WaRoutesOpts> = (app, opts, done) => {
  const { env, db, boss } = opts;

  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, cb) =>
    cb(null, body),
  );

  app.get('/webhook', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === env.WA_VERIFY_TOKEN) {
      return reply.code(200).send(q['hub.challenge'] ?? '');
    }
    return reply.code(403).send();
  });

  app.post('/webhook', async (req, reply) => {
    const raw = req.body as Buffer;
    const assinatura = req.headers['x-hub-signature-256'];
    if (
      !verifySignature(
        raw,
        env.WA_APP_SECRET,
        typeof assinatura === 'string' ? assinatura : undefined,
      )
    ) {
      return reply.code(401).send({ erro: 'assinatura inválida' });
    }

    try {
      const payload = WebhookPayloadSchema.parse(JSON.parse(raw.toString('utf-8')));
      for (const msg of parseInboundTexts(payload)) {
        await processInbound({ db, boss, debounceMs: env.WA_DEBOUNCE_MS }, msg);
      }
      for (const st of parseStatuses(payload)) {
        await db
          .update(mensagem)
          .set({ status: STATUS_MAP[st.status] })
          .where(eq(mensagem.waMessageId, st.waMessageId));
      }
    } catch (err) {
      // payload inesperado nunca derruba o webhook — Meta re-tenta em não-200
      req.log.warn({ err }, 'payload de webhook não processado');
    }
    return reply.code(200).send({ ok: true });
  });

  done();
};
