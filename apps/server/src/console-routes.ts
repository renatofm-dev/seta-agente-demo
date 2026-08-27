import { TransicaoInvalidaError } from '@seta/crm';
import { newTraceId } from '@seta/observability';
import type { Executor } from '@seta/query-catalog';
import { and, asc, desc, eq, gt, inArray } from 'drizzle-orm';
import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';
import type { PgBoss } from 'pg-boss';
import { z } from 'zod';
import { type Auth, type SessaoConsole, sessaoDaRequest } from './auth.js';
import type { Db } from './db/index.js';
import { contato, conversa, mensagem, sinalAprendizado, ticket, traceTurno } from './db/schema.js';
import { agendarDebounce } from './wa/inbound.js';
import { enqueueOutbound } from './wa/outbox.js';
import { aplicarTransicao } from './wa/tickets.js';

/**
 * API do console HITL (007): inbox em três filas, detalhe do ticket com dados
 * do ERP via catálogo, ações assumir/responder/devolver/resolver e SSE.
 * Toda rota exige sessão Better Auth (papéis atendente|curador).
 */

export interface ConsoleRoutesOpts {
  readonly db: Db;
  readonly boss: PgBoss;
  readonly auth: Auth;
  readonly executor: Executor;
  readonly debounceMs: number;
}

const sessoes = new WeakMap<FastifyRequest, SessaoConsole>();

async function ticketComContexto(db: Db, t: typeof ticket.$inferSelect) {
  const [conv] = await db.select().from(conversa).where(eq(conversa.id, t.conversaId));
  const [vinculo] = conv
    ? await db.select().from(contato).where(eq(contato.waId, conv.waId))
    : [undefined];
  const [ultima] = await db
    .select()
    .from(mensagem)
    .where(eq(mensagem.conversaId, t.conversaId))
    .orderBy(desc(mensagem.criadoEm))
    .limit(1);
  return {
    id: t.id,
    conversaId: t.conversaId,
    status: t.status,
    atendenteId: t.atendenteId,
    motivoEscalonamento: t.motivoEscalonamento,
    esperaSegundos: t.escaladoEm ? Math.round((Date.now() - t.escaladoEm.getTime()) / 1000) : null,
    waId: conv?.waId ?? null,
    contatoNome: vinculo?.nome ?? null,
    clienteErpId: vinculo?.clienteErpId ?? null,
    ultimaMensagem: ultima
      ? { texto: ultima.texto, autor: ultima.autor, em: ultima.criadoEm }
      : null,
  };
}

export const consoleRoutes: FastifyPluginCallback<ConsoleRoutesOpts> = (app, opts, done) => {
  const { db, boss, auth, executor } = opts;

  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    const sessao = await sessaoDaRequest(auth, req.headers);
    if (!sessao) return reply.code(401).send({ erro: 'não autenticado' });
    sessoes.set(req, sessao);
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof TransicaoInvalidaError) {
      return reply.code(409).send({ erro: err.message });
    }
    req.log.error(err, 'erro na api do console');
    return reply.code(500).send({ erro: 'erro interno' });
  });
  const sessaoDe = (req: FastifyRequest): SessaoConsole => {
    const s = sessoes.get(req);
    if (!s) throw new Error('sessão ausente após preHandler');
    return s;
  };

  app.get('/api/console/me', async (req) => sessaoDe(req));

  app.get('/api/console/inbox', async (req) => {
    const sessao = sessaoDe(req);
    const tickets = await db
      .select()
      .from(ticket)
      .where(inArray(ticket.status, ['bot_ativo', 'aguardando_humano', 'humano_ativo']))
      .orderBy(desc(ticket.atualizadoEm));
    const enriquecidos = await Promise.all(tickets.map((t) => ticketComContexto(db, t)));
    return {
      botAtivo: enriquecidos.filter((t) => t.status === 'bot_ativo'),
      aguardando: enriquecidos.filter((t) => t.status === 'aguardando_humano'),
      meus: enriquecidos.filter(
        (t) => t.status === 'humano_ativo' && t.atendenteId === sessao.userId,
      ),
    };
  });

  app.get('/api/console/ticket/:id', async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const [t] = await db.select().from(ticket).where(eq(ticket.id, id));
    if (!t) return reply.code(404).send({ erro: 'ticket inexistente' });
    const contexto = await ticketComContexto(db, t);
    const mensagens = await db
      .select()
      .from(mensagem)
      .where(eq(mensagem.conversaId, t.conversaId))
      .orderBy(asc(mensagem.criadoEm));

    // painel lateral: dados do cliente ERP via catálogo (cliente.perfil)
    let perfilErp: Record<string, unknown> | null = null;
    if (contexto.clienteErpId) {
      try {
        const r = await executor.run(
          'cliente.perfil',
          {},
          { traceId: newTraceId(), clienteId: contexto.clienteErpId },
        );
        perfilErp = (r.rows[0] as Record<string, unknown>) ?? null;
      } catch (err) {
        req.log.warn({ err }, 'perfil ERP indisponível para o painel');
      }
    }
    return {
      ...contexto,
      mensagens: mensagens.map((m) => ({
        id: m.id,
        autor: m.autor,
        texto: m.texto,
        status: m.status,
        criadoEm: m.criadoEm,
      })),
      perfilErp,
    };
  });

  const carregarTicket = async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const [t] = await db.select().from(ticket).where(eq(ticket.id, id));
    if (!t) {
      await reply.code(404).send({ erro: 'ticket inexistente' });
      return null;
    }
    return t;
  };

  app.post('/api/console/ticket/:id/assumir', async (req, reply) => {
    const sessao = sessaoDe(req);
    const t = await carregarTicket(req, reply);
    if (!t) return;
    const atualizado = await aplicarTransicao(db, t, 'humano_ativo', 'atendente', {
      atorId: sessao.userId,
    });
    return { status: atualizado.status };
  });

  app.post('/api/console/ticket/:id/devolver', async (req, reply) => {
    const sessao = sessaoDe(req);
    const t = await carregarTicket(req, reply);
    if (!t) return;
    const atualizado = await aplicarTransicao(db, t, 'bot_ativo', 'atendente', {
      atorId: sessao.userId,
    });
    // reativa o bot: varre mensagens pendentes acumuladas durante o atendimento
    await agendarDebounce(boss, t.conversaId, opts.debounceMs);
    return { status: atualizado.status };
  });

  app.post('/api/console/ticket/:id/resolver', async (req, reply) => {
    const sessao = sessaoDe(req);
    const t = await carregarTicket(req, reply);
    if (!t) return;
    const atualizado = await aplicarTransicao(db, t, 'resolvido', 'atendente', {
      atorId: sessao.userId,
    });
    return { status: atualizado.status };
  });

  app.post('/api/console/ticket/:id/responder', async (req, reply) => {
    const sessao = sessaoDe(req);
    const t = await carregarTicket(req, reply);
    if (!t) return;
    if (t.status !== 'humano_ativo' || t.atendenteId !== sessao.userId) {
      return reply.code(409).send({ erro: 'ticket não está sob seu atendimento' });
    }
    const body = z
      .object({ texto: z.string().min(1).max(4096), chave: z.string().min(8).max(64) })
      .parse(req.body);

    // sinal de correção HITL (insumo da 009): primeira resposta do atendente
    // desde a escalada é pareada ao último draft/resposta do bot
    const sinaisDestaEscalada = t.escaladoEm
      ? await db
          .select({ id: sinalAprendizado.id })
          .from(sinalAprendizado)
          .where(
            and(
              eq(sinalAprendizado.ticketId, t.id),
              eq(sinalAprendizado.tipo, 'correcao_hitl'),
              gt(sinalAprendizado.criadoEm, t.escaladoEm),
            ),
          )
          .limit(1)
      : [];
    if (sinaisDestaEscalada.length === 0) {
      const [ultimoTrace] = await db
        .select()
        .from(traceTurno)
        .where(eq(traceTurno.conversaId, t.conversaId))
        .orderBy(desc(traceTurno.criadoEm))
        .limit(1);
      await db.insert(sinalAprendizado).values({
        id: newTraceId(),
        tipo: 'correcao_hitl',
        ticketId: t.id,
        conversaId: t.conversaId,
        payload: {
          draftBot: ultimoTrace?.resposta ?? null,
          traceTurnoId: ultimoTrace?.id ?? null,
          respostaHumano: body.texto,
          motivoEscalonamento: t.motivoEscalonamento,
          atendenteId: sessao.userId,
        },
      });
    }

    const r = await enqueueOutbound(
      { db, boss },
      { conversaId: t.conversaId, chave: body.chave, texto: body.texto, autor: 'atendente' },
    );
    return reply.code(202).send(r);
  });

  app.get('/api/console/events', async (req, reply) => {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    reply.raw.write(': conectado\n\n');
    const vistos = new Set<string>();
    let cursorTicket = new Date(0);
    let cursorMsg = new Date(0);
    const recuo = (d: Date) => new Date(d.getTime() - 1_000);
    const timer = setInterval(async () => {
      try {
        const tickets = await db
          .select()
          .from(ticket)
          .where(gt(ticket.atualizadoEm, recuo(cursorTicket)))
          .orderBy(asc(ticket.atualizadoEm));
        for (const t of tickets) {
          cursorTicket = t.atualizadoEm;
          const chave = `${t.id}:${t.atualizadoEm.getTime()}:${t.status}`;
          if (vistos.has(chave)) continue;
          vistos.add(chave);
          reply.raw.write(
            `event: ticket\ndata: ${JSON.stringify(await ticketComContexto(db, t))}\n\n`,
          );
        }
        const msgs = await db
          .select()
          .from(mensagem)
          .where(gt(mensagem.criadoEm, recuo(cursorMsg)))
          .orderBy(asc(mensagem.criadoEm));
        for (const m of msgs) {
          cursorMsg = m.criadoEm;
          if (vistos.has(m.id)) continue;
          vistos.add(m.id);
          reply.raw.write(
            `event: mensagem\ndata: ${JSON.stringify({
              id: m.id,
              conversaId: m.conversaId,
              autor: m.autor,
              texto: m.texto,
              criadoEm: m.criadoEm,
            })}\n\n`,
          );
        }
      } catch (err) {
        req.log.warn({ err }, 'sse console: falha na consulta');
      }
    }, 1_000);
    req.raw.on('close', () => clearInterval(timer));
  });

  done();
};
