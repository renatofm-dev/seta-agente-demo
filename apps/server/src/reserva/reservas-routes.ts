import { TEXTO_RECUSADA } from '@seta/reserva';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { FastifyPluginCallback, FastifyRequest } from 'fastify';
import type { PgBoss } from 'pg-boss';
import { z } from 'zod';
import type { Auth } from '../auth.js';
import { type SessaoConsole, sessaoDaRequest } from '../auth.js';
import { FILA_ERP_RESERVA } from '../boss.js';
import type { Db } from '../db/index.js';
import { erpEscrita, reserva, STATUS_RESERVA } from '../db/schema.js';
import { enqueueOutbound } from '../wa/outbox.js';
import { chaveReserva } from './chave.js';

/**
 * Console de reservas (038). Molde de `pagamentos/cobrancas-routes.ts`: auth por
 * preHandler, Zod inline, UPDATE condicional no status como trava de
 * concorrência (404 × 409) e job só depois do commit.
 *
 * A aprovação aqui **não segura dinheiro nosso** — segura o compromisso do
 * cotista com uma taxa de manutenção que o ERP vai faturar. Por isso tabela,
 * teto e trigger próprios, sem tocar em `pagamentos/`.
 */

export interface ReservasRoutesOpts {
  readonly db: Db;
  readonly boss: PgBoss;
  readonly auth: Auth;
}

const sessoes = new WeakMap<FastifyRequest, SessaoConsole>();
const ParamsId = z.object({ id: z.uuid() });
const QueryLista = z.object({
  status: z.enum(STATUS_RESERVA).optional(),
  /** Aba Reservas do painel de contexto: só as desta conversa. */
  conversaId: z.uuid().optional(),
});
const BodyRecusa = z.object({ motivo: z.string().min(3).max(300) });

export const reservasRoutes: FastifyPluginCallback<ReservasRoutesOpts> = (app, opts, done) => {
  const { db, boss, auth } = opts;

  app.addHook('preHandler', async (req, reply) => {
    const sessao = await sessaoDaRequest(auth, req.headers);
    if (!sessao) return reply.code(401).send({ erro: 'não autenticado' });
    sessoes.set(req, sessao);
  });
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof z.ZodError) return reply.code(400).send({ erro: z.prettifyError(err) });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      req.log.warn({ err }, 'requisição recusada');
      return reply.code(status).send({ erro: (err as Error).message });
    }
    req.log.error(err);
    return reply.code(500).send({ erro: 'erro interno' });
  });
  const sessaoDe = (req: FastifyRequest): SessaoConsole => {
    const s = sessoes.get(req);
    if (!s) throw new Error('sessão ausente após preHandler');
    return s;
  };

  app.get('/api/console/reservas', async (req) => {
    const q = QueryLista.parse(req.query ?? {});
    const linhas = await db
      .select()
      .from(reserva)
      .where(
        and(
          q.status ? eq(reserva.status, q.status) : undefined,
          q.conversaId ? eq(reserva.conversaId, q.conversaId) : undefined,
        ),
      )
      .orderBy(desc(reserva.criadoEm))
      .limit(200);
    const contagens = await db
      .select({ status: reserva.status, n: sql<number>`count(*)::int` })
      .from(reserva)
      .groupBy(reserva.status);
    return {
      reservas: linhas,
      contagens: Object.fromEntries(contagens.map((c) => [c.status, c.n])),
    };
  });

  app.get('/api/console/reservas/:id', async (req, reply) => {
    const { id } = ParamsId.parse(req.params);
    const [r] = await db.select().from(reserva).where(eq(reserva.id, id));
    if (!r) return reply.code(404).send({ erro: 'reserva não encontrada' });
    const [escrita] = await db
      .select()
      .from(erpEscrita)
      .where(eq(erpEscrita.chave, chaveReserva(id)));
    return { reserva: r, escrita: escrita ?? null };
  });

  /**
   * Aprovar enfileira a escrita no ERP — é aqui que a reserva acima do teto sai
   * do papel. O UPDATE condicional resolve o duplo-clique sem lock.
   */
  app.post('/api/console/reservas/:id/aprovar', async (req, reply) => {
    const { id } = ParamsId.parse(req.params);
    const sessao = sessaoDe(req);
    const [alvo] = await db
      .update(reserva)
      .set({
        status: 'criando',
        aprovadoPor: sessao.userId,
        aprovadoEm: new Date(),
        atualizadoEm: new Date(),
      })
      .where(and(eq(reserva.id, id), eq(reserva.status, 'aguardando_aprovacao')))
      .returning({ id: reserva.id });
    if (!alvo) {
      const [r] = await db
        .select({ status: reserva.status })
        .from(reserva)
        .where(eq(reserva.id, id));
      if (!r) return reply.code(404).send({ erro: 'reserva não encontrada' });
      return reply.code(409).send({ erro: `reserva não está aguardando aprovação (${r.status})` });
    }
    const [escrita] = await db
      .insert(erpEscrita)
      .values({
        chave: chaveReserva(id),
        operacao: 'reserva',
        alvo: id,
        payload: { reservaId: id, aprovadaPor: sessao.userId },
      })
      .onConflictDoNothing({ target: erpEscrita.chave })
      .returning({ chave: erpEscrita.chave });
    if (escrita) await boss.send(FILA_ERP_RESERVA, { reservaId: id });
    return reply.code(202).send({ ok: true });
  });

  app.post('/api/console/reservas/:id/recusar', async (req, reply) => {
    const { id } = ParamsId.parse(req.params);
    const { motivo } = BodyRecusa.parse(req.body);
    const [alvo] = await db
      .update(reserva)
      .set({ status: 'recusada', motivo, atualizadoEm: new Date() })
      .where(and(eq(reserva.id, id), eq(reserva.status, 'aguardando_aprovacao')))
      .returning({ id: reserva.id, conversaId: reserva.conversaId });
    if (!alvo) {
      const [r] = await db
        .select({ status: reserva.status })
        .from(reserva)
        .where(eq(reserva.id, id));
      if (!r) return reply.code(404).send({ erro: 'reserva não encontrada' });
      return reply.code(409).send({ erro: `reserva não está aguardando aprovação (${r.status})` });
    }
    // o cotista fica sabendo: o outbox cuida da janela de 24h
    await enqueueOutbound(
      { db, boss },
      {
        conversaId: alvo.conversaId,
        chave: `reserva:${id}:recusada`,
        texto: TEXTO_RECUSADA,
        autor: 'bot',
      },
    );
    return { ok: true };
  });

  done();
};
