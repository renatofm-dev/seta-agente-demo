import { desc, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyPluginCallback } from 'fastify';
import type { PgBoss } from 'pg-boss';
import { z } from 'zod';
import { type Auth, sessaoDaRequest } from '../auth.js';
import type { Db } from '../db/index.js';
import { cobranca, eventoPsp } from '../db/schema.js';
import { reenfileirarEventoPsp } from './eventos.js';

/**
 * Eventos do PSP no console (042). Recurso próprio, e não um sub-recurso de
 * cobrança, porque um evento pendente pode não pertencer a cobrança nenhuma:
 * quando o `payment.id` não resolve, o evento fica com `erro = 'cobrança
 * desconhecida'` e nenhum drawer de cobrança o alcança. Esta é a única
 * superfície que enxerga — e reprocessa — esses órfãos.
 */

export interface EventosPspRoutesOpts {
  readonly db: Db;
  readonly boss: PgBoss;
  readonly auth: Auth;
}

/** Id de evento do Asaas é `text` e contém `&` (`evt_<hash>&<sequência>`) — nunca uuid. */
const ParamsEventoId = z.object({ id: z.string().min(1).max(200) });

const QueryLista = z.object({
  // `z.coerce.boolean()` transformaria a string "false" em true — stringbool não.
  pendente: z.stringbool().optional(),
  limite: z.coerce.number().int().min(1).max(500).default(200),
});

export const eventosPspRoutes: FastifyPluginCallback<EventosPspRoutesOpts> = (app, opts, done) => {
  const { db, boss, auth } = opts;

  app.addHook('preHandler', async (req, reply) => {
    const sessao = await sessaoDaRequest(auth, req.headers);
    if (!sessao) return reply.code(401).send({ erro: 'não autenticado' });
  });
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof z.ZodError) {
      return reply.code(400).send({ erro: z.prettifyError(err) });
    }
    // requisição malformada é 4xx do próprio Fastify — mascarar de 500 esconde a causa
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      req.log.warn({ err }, 'requisição recusada');
      return reply.code(status).send({ erro: (err as Error).message });
    }
    req.log.error(err);
    return reply.code(500).send({ erro: 'erro interno' });
  });

  app.get('/api/console/eventos-psp', async (req) => {
    const q = QueryLista.parse(req.query);
    // subconsulta correlacionada, não join: `cobranca_psp_idx` não é unique e
    // um join direto multiplicaria a linha do evento.
    const cobrancaDo = db
      .select({ id: cobranca.id })
      .from(cobranca)
      .where(eq(cobranca.pspCobrancaId, eventoPsp.pspCobrancaId))
      .orderBy(desc(cobranca.criadoEm))
      .limit(1);
    const eventos = await db
      .select({
        id: eventoPsp.id,
        psp: eventoPsp.psp,
        tipo: eventoPsp.tipo,
        pspCobrancaId: eventoPsp.pspCobrancaId,
        recebidoEm: eventoPsp.recebidoEm,
        processadoEm: eventoPsp.processadoEm,
        erro: eventoPsp.erro,
        cobrancaId: sql<string | null>`(${cobrancaDo})`,
      })
      .from(eventoPsp)
      .where(q.pendente ? isNull(eventoPsp.processadoEm) : undefined)
      .orderBy(desc(eventoPsp.recebidoEm))
      .limit(q.limite);
    const [pendentes] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(eventoPsp)
      .where(isNull(eventoPsp.processadoEm));
    return { eventos, pendentes: pendentes?.n ?? 0 };
  });

  /** Reenfileira um evento preso. Já processado é no-op, não conflito. */
  app.post('/api/console/eventos-psp/:id/reprocessar', async (req, reply) => {
    const { id } = ParamsEventoId.parse(req.params);
    const r = await reenfileirarEventoPsp({ db, boss }, id);
    if (r === 'inexistente') return reply.code(404).send({ erro: 'evento não existe' });
    if (r === 'ja-processado') {
      return reply
        .code(200)
        .send({ ok: true, reenfileirado: false, motivo: 'evento já processado' });
    }
    req.log.info({ eventoId: id }, 'evento do PSP reenfileirado pelo console');
    return reply.code(202).send({ ok: true, reenfileirado: true });
  });

  done();
};
