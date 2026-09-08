import { timingSafeEqual } from 'node:crypto';
import type { FastifyPluginCallback } from 'fastify';
import type { PgBoss } from 'pg-boss';
import type { Db } from '../db/index.js';
import type { Env } from '../env.js';
import { EventoPspBodySchema, registrarEventoPsp } from './eventos.js';

/**
 * Webhook do Asaas (014). Autenticação por token em tempo constante ANTES de
 * qualquer efeito; persiste o evento (idempotente pelo id) e responde 200 na
 * hora — o Asaas interrompe a fila após 15 falhas seguidas, então processar
 * fica para o worker.
 */

export interface WebhookPspRoutesOpts {
  readonly env: Pick<Env, 'ASAAS_WEBHOOK_TOKEN'>;
  readonly db: Db;
  readonly boss: PgBoss;
}

export function tokenConfere(recebido: string | undefined, esperado: string): boolean {
  if (typeof recebido !== 'string') return false;
  const a = Buffer.from(recebido, 'utf-8');
  const b = Buffer.from(esperado, 'utf-8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export const webhookPspRoutes: FastifyPluginCallback<WebhookPspRoutesOpts> = (app, opts, done) => {
  app.post('/webhooks/asaas', async (req, reply) => {
    const esperado = opts.env.ASAAS_WEBHOOK_TOKEN;
    if (!esperado) {
      return reply.code(503).send({ erro: 'ASAAS_WEBHOOK_TOKEN não configurado no server' });
    }
    const header = req.headers['asaas-access-token'];
    if (!tokenConfere(Array.isArray(header) ? header[0] : header, esperado)) {
      req.log.warn('webhook asaas com token inválido — ignorado');
      return reply.code(401).send({ erro: 'token inválido' });
    }
    const parsed = EventoPspBodySchema.safeParse(req.body);
    if (!parsed.success) {
      req.log.warn({ corpo: req.body }, 'webhook asaas com corpo inesperado');
      return reply.code(400).send({ erro: 'corpo inválido' });
    }
    const { novo } = await registrarEventoPsp(
      { db: opts.db, boss: opts.boss },
      'asaas',
      parsed.data,
    );
    req.log.info({ eventoId: parsed.data.id, event: parsed.data.event, novo }, 'webhook asaas');
    return reply.code(200).send({ recebido: true, duplicado: !novo });
  });
  done();
};
