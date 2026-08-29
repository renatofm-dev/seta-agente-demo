import { newTraceId } from '@seta/observability';
import { WaPhoneSchema } from '@seta/wa-meta';
import { and, asc, eq, gt } from 'drizzle-orm';
import type { FastifyPluginCallback } from 'fastify';
import type { PgBoss } from 'pg-boss';
import { z } from 'zod';
import { type Auth, sessaoDaRequest } from '../auth.js';
import type { Db } from '../db/index.js';
import { conversa, mensagem, turno } from '../db/schema.js';
import type { Env } from '../env.js';
import { processInbound } from './inbound.js';

/**
 * Simulador dev (DEV_SIMULATOR=true): injeta mensagens no MESMO caminho do
 * webhook (mesma idempotência, mesmo debounce) e transmite a conversa via SSE.
 * É o plano B da demo (000). Com `auth` presente (011: exposto na demo
 * pública), TODA rota /dev exige sessão do console — sem isso qualquer um com
 * a URL injeta mensagens como qualquer waId e lê conversas alheias.
 */

export interface DevRoutesOpts {
  readonly env: Env;
  readonly db: Db;
  readonly boss: PgBoss;
  /** Presente ⇒ /dev/* exige sessão Better Auth (atendente|curador). */
  readonly auth?: Auth;
}

const InboundBodySchema = z.object({
  waId: WaPhoneSchema,
  text: z.string().min(1).max(4096),
});

const SSE_INTERVALO_MS = 700;

export const devRoutes: FastifyPluginCallback<DevRoutesOpts> = (app, opts, done) => {
  const { env, db, boss, auth } = opts;

  if (auth) {
    app.addHook('preHandler', async (req, reply) => {
      const sessao = await sessaoDaRequest(auth, req.headers);
      if (!sessao) return reply.code(401).send({ erro: 'não autenticado' });
    });
  }

  app.post('/dev/inbound', async (req, reply) => {
    const body = InboundBodySchema.parse(req.body);
    const resultado = await processInbound(
      { db, boss, debounceMs: env.WA_DEBOUNCE_MS },
      {
        waId: body.waId,
        waMessageId: `sim-${newTraceId()}`,
        texto: body.text,
        timestamp: new Date(),
      },
    );
    return reply.code(202).send(resultado);
  });

  app.get('/dev/events', async (req, reply) => {
    const { waId } = z.object({ waId: WaPhoneSchema }).parse(req.query);
    // sem CORS: o console consome via rewrite same-origin do Next
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    reply.raw.write(': conectado\n\n');

    // cursor recuado 1s + dedupe por id: o timestamptz tem precisão de µs e o
    // Date JS trunca em ms — comparar só por `>` re-emitiria a última linha
    const vistos = new Set<string>();
    let cursorMsg = new Date(0);
    let cursorTurno = new Date(0);
    const recuo = (d: Date) => new Date(d.getTime() - 1_000);
    const timer = setInterval(async () => {
      try {
        const [conv] = await db.select().from(conversa).where(eq(conversa.waId, waId));
        if (!conv) return;
        const novas = await db
          .select()
          .from(mensagem)
          .where(and(eq(mensagem.conversaId, conv.id), gt(mensagem.criadoEm, recuo(cursorMsg))))
          .orderBy(asc(mensagem.criadoEm));
        for (const m of novas) {
          cursorMsg = m.criadoEm;
          if (vistos.has(m.id)) continue;
          vistos.add(m.id);
          reply.raw.write(
            `event: mensagem\ndata: ${JSON.stringify({
              id: m.id,
              direcao: m.direcao,
              texto: m.texto,
              status: m.status,
              criadoEm: m.criadoEm,
            })}\n\n`,
          );
        }
        const turnos = await db
          .select()
          .from(turno)
          .where(and(eq(turno.conversaId, conv.id), gt(turno.criadoEm, recuo(cursorTurno))))
          .orderBy(asc(turno.criadoEm));
        for (const t of turnos) {
          cursorTurno = t.criadoEm;
          if (vistos.has(t.id)) continue;
          vistos.add(t.id);
          reply.raw.write(
            `event: turno\ndata: ${JSON.stringify({ id: t.id, textoAgregado: t.textoAgregado })}\n\n`,
          );
        }
      } catch (err) {
        req.log.warn({ err }, 'sse: falha ao consultar conversa');
      }
    }, SSE_INTERVALO_MS);

    req.raw.on('close', () => clearInterval(timer));
  });

  done();
};
