import { TEXTO_RECUSADO } from '@seta/cobranca';
import { newTraceId } from '@seta/observability';
import type { PaymentProvider } from '@seta/payment-provider';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyPluginCallback, FastifyRequest } from 'fastify';
import type { PgBoss } from 'pg-boss';
import { z } from 'zod';
import { type Auth, type SessaoConsole, sessaoDaRequest } from '../auth.js';
import { FILA_COBRANCA_EMITIR } from '../boss.js';
import type { Db } from '../db/index.js';
import {
  cobranca,
  cobrancaTitulo,
  contato,
  conversa,
  eventoPsp,
  STATUS_COBRANCA,
  ticket,
} from '../db/schema.js';
import type { Env } from '../env.js';
import { enqueueOutbound } from '../wa/outbox.js';
import { registrarEventoPsp } from './eventos.js';
import type { PagamentosRepo } from './repo.js';

/**
 * Console de cobranças (014): listar, detalhar, aprovar/recusar as que
 * esperam aprovação humana e — só em dev — simular o pagamento.
 * Mesmo padrão das rotas da 013 (auth por preHandler, Zod, tx + job após commit).
 */

export interface CobrancasRoutesOpts {
  readonly env: Pick<Env, 'DEV_SIMULATOR'>;
  readonly db: Db;
  readonly boss: PgBoss;
  readonly auth: Auth;
  readonly repo: PagamentosRepo;
  readonly psp: PaymentProvider;
}

const sessoes = new WeakMap<FastifyRequest, SessaoConsole>();
const ParamsId = z.object({ id: z.uuid() });
const QueryLista = z.object({
  status: z.enum(STATUS_COBRANCA).optional(),
  /** Aba Cobranças do painel de contexto: só as desta conversa. */
  conversaId: z.uuid().optional(),
});
const BodyRecusa = z.object({ motivo: z.string().min(3).max(300) });

export const cobrancasRoutes: FastifyPluginCallback<CobrancasRoutesOpts> = (app, opts, done) => {
  const { db, boss, auth, repo, psp, env } = opts;
  /**
   * 042: o simulador também depende do ambiente. Com chave real o botão chama
   * `receiveInCash` de verdade — no sandbox é o desejado, em produção seria
   * baixa indevida. Fonte única: a rota e o console leem esta mesma expressão.
   */
  const simuladorAtivo = env.DEV_SIMULATOR && psp.ambiente !== 'producao';

  app.addHook('preHandler', async (req, reply) => {
    const sessao = await sessaoDaRequest(auth, req.headers);
    if (!sessao) return reply.code(401).send({ erro: 'não autenticado' });
    sessoes.set(req, sessao);
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
  const sessaoDe = (req: FastifyRequest): SessaoConsole => {
    const s = sessoes.get(req);
    if (!s) throw new Error('sessão ausente após preHandler');
    return s;
  };

  app.get('/api/console/cobrancas', async (req) => {
    const q = QueryLista.parse(req.query ?? {});
    const linhas = await db
      .select({
        id: cobranca.id,
        conversaId: cobranca.conversaId,
        contratoId: cobranca.contratoId,
        status: cobranca.status,
        metodo: cobranca.metodo,
        valorCentavos: cobranca.valorCentavos,
        vencimentoPsp: cobranca.vencimentoPsp,
        psp: cobranca.psp,
        pspCobrancaId: cobranca.pspCobrancaId,
        urlFatura: cobranca.urlFatura,
        urlBoleto: cobranca.urlBoleto,
        motivo: cobranca.motivo,
        aprovadoPor: cobranca.aprovadoPor,
        pagoEm: cobranca.pagoEm,
        criadoEm: cobranca.criadoEm,
        atualizadoEm: cobranca.atualizadoEm,
        waId: conversa.waId,
        contatoNome: contato.nome,
        ticketId: ticket.id,
        parcelas: sql<string>`(
          SELECT string_agg(
            'parcela ' || ct.parcela || coalesce('/' || ct.total_parcelas, '') || ' (' || ct.origem || ')',
            ', ' ORDER BY ct.vencimento
          ) FROM cobranca_titulo ct WHERE ct.cobranca_id = ${cobranca.id}
        )`,
      })
      .from(cobranca)
      .innerJoin(conversa, eq(conversa.id, cobranca.conversaId))
      .leftJoin(contato, eq(contato.waId, conversa.waId))
      .leftJoin(ticket, eq(ticket.conversaId, cobranca.conversaId))
      .where(
        and(
          q.status ? eq(cobranca.status, q.status) : undefined,
          q.conversaId ? eq(cobranca.conversaId, q.conversaId) : undefined,
        ),
      )
      .orderBy(desc(cobranca.criadoEm))
      .limit(200);
    const contagens = await db
      .select({ status: cobranca.status, n: sql<number>`count(*)::int` })
      .from(cobranca)
      .groupBy(cobranca.status);
    const [pendentes] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(eventoPsp)
      .where(isNull(eventoPsp.processadoEm));
    return {
      psp: psp.nome,
      ambiente: psp.ambiente,
      simuladorAtivo,
      contagens: Object.fromEntries(contagens.map((c) => [c.status, c.n])),
      eventosPspPendentes: pendentes?.n ?? 0,
      cobrancas: linhas,
    };
  });

  app.get('/api/console/cobrancas/:id', async (req, reply) => {
    const { id } = ParamsId.parse(req.params);
    const c = await repo.cobrancaPorId(id);
    if (!c) return reply.code(404).send({ erro: 'cobrança não existe' });
    const [titulos, eventos] = await Promise.all([
      db.select().from(cobrancaTitulo).where(eq(cobrancaTitulo.cobrancaId, id)),
      c.pspCobrancaId
        ? db
            .select({
              id: eventoPsp.id,
              tipo: eventoPsp.tipo,
              recebidoEm: eventoPsp.recebidoEm,
              processadoEm: eventoPsp.processadoEm,
              erro: eventoPsp.erro,
            })
            .from(eventoPsp)
            .where(eq(eventoPsp.pspCobrancaId, c.pspCobrancaId))
            .orderBy(desc(eventoPsp.recebidoEm))
        : Promise.resolve([]),
    ]);
    return { cobranca: c, titulos, eventos };
  });

  /** Aprovação humana: aguardando_aprovacao → emitindo + job (UPDATE condicional no status). */
  app.post('/api/console/cobrancas/:id/aprovar', async (req, reply) => {
    const { id } = ParamsId.parse(req.params);
    const sessao = sessaoDe(req);
    const [atualizada] = await db
      .update(cobranca)
      .set({
        status: 'emitindo',
        aprovadoPor: sessao.userId,
        aprovadoEm: new Date(),
        atualizadoEm: new Date(),
      })
      .where(and(eq(cobranca.id, id), eq(cobranca.status, 'aguardando_aprovacao')))
      .returning({ id: cobranca.id });
    if (!atualizada) {
      const c = await repo.cobrancaPorId(id);
      if (!c) return reply.code(404).send({ erro: 'cobrança não existe' });
      return reply.code(409).send({ erro: `cobrança não está aguardando aprovação (${c.status})` });
    }
    await boss.send(FILA_COBRANCA_EMITIR, { cobrancaId: id });
    return reply.code(202).send({ ok: true });
  });

  app.post('/api/console/cobrancas/:id/recusar', async (req, reply) => {
    const { id } = ParamsId.parse(req.params);
    const body = BodyRecusa.parse(req.body);
    const sessao = sessaoDe(req);
    const [atualizada] = await db
      .update(cobranca)
      .set({
        status: 'recusada',
        motivo: body.motivo,
        aprovadoPor: sessao.userId,
        aprovadoEm: new Date(),
        atualizadoEm: new Date(),
      })
      .where(and(eq(cobranca.id, id), eq(cobranca.status, 'aguardando_aprovacao')))
      .returning({ id: cobranca.id, conversaId: cobranca.conversaId });
    if (!atualizada) {
      const c = await repo.cobrancaPorId(id);
      if (!c) return reply.code(404).send({ erro: 'cobrança não existe' });
      return reply.code(409).send({ erro: `cobrança não está aguardando aprovação (${c.status})` });
    }
    // aviso ao cotista (o outbox cuida da janela: fechada ⇒ janela_fechada + ticket)
    await enqueueOutbound(
      { db, boss },
      {
        conversaId: atualizada.conversaId,
        chave: `cobranca:${id}:recusada`,
        texto: TEXTO_RECUSADO,
        autor: 'bot',
      },
    );
    return reply.code(200).send({ ok: true });
  });

  /**
   * Dev/demo: simula o recebimento. PSP real ⇒ receiveInCash no sandbox (o Asaas
   * dispara o webhook de verdade); PSP simulado ⇒ injeta o evento no MESMO
   * caminho do webhook. Nunca em produção (042): lá isso seria baixa indevida.
   */
  app.post('/api/console/cobrancas/:id/simular-pagamento', async (req, reply) => {
    if (!simuladorAtivo) return reply.code(404).send({ erro: 'simulador desligado' });
    const { id } = ParamsId.parse(req.params);
    const c = await repo.cobrancaPorId(id);
    if (!c) return reply.code(404).send({ erro: 'cobrança não existe' });
    if (c.status !== 'emitida' || !c.pspCobrancaId) {
      return reply.code(409).send({ erro: `cobrança não está emitida (${c.status})` });
    }
    await psp.simularRecebimento(c.pspCobrancaId, c.valorCentavos);
    if (psp.nome === 'simulado') {
      await registrarEventoPsp({ db, boss }, 'simulado', {
        id: `sim-evt-${newTraceId()}`,
        event: 'PAYMENT_RECEIVED',
        payment: {
          id: c.pspCobrancaId,
          status: 'RECEIVED',
          value: c.valorCentavos / 100,
          externalReference: c.referenciaExterna,
          paymentDate: new Date().toISOString().slice(0, 10),
        },
      });
    }
    return reply.code(202).send({ ok: true, psp: psp.nome });
  });

  done();
};
