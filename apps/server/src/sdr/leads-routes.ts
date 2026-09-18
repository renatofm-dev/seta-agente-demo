import { newTraceId } from '@seta/observability';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError, z } from 'zod';
import { type Auth, type SessaoConsole, sessaoDaRequest } from '../auth.js';
import type { Db } from '../db/index.js';
import { fluxoSdr, lead, propostaSdr, sinalAprendizado } from '../db/schema.js';
import { aplicarDecisaoHumana, type SdrFluxoDeps } from './fluxo.js';

/**
 * Leads da 015 no console — e, com a **015b**, a decisão da proposta que passou
 * da alçada.
 *
 * Até aqui a tela mostrava a proposta `aguardando_aprovacao` e parava: o lead
 * ficava **sem resposta nenhuma** até alguém falar com ele pela conversa. Agora
 * um humano decide, o lead é avisado pelo WhatsApp e a decisão fica no trace.
 *
 * Molde de `pagamentos/cobrancas-routes.ts`: UPDATE condicional no status como
 * trava de concorrência (404 × 409), efeito só depois do commit.
 */

export interface LeadsRoutesOpts {
  readonly db: Db;
  readonly auth: Auth;
  /** 015b: ausente ⇒ as rotas de decisão não são registradas (a 015a segue só leitura). */
  readonly sdr?: SdrFluxoDeps | null;
}

interface PerfilLead {
  readonly pessoas: number | null;
  readonly periodos: number | null;
  readonly contato: string | null;
}

function perfilDe(v: unknown): PerfilLead {
  const p = (v ?? {}) as Record<string, unknown>;
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
  return {
    pessoas: n(p.pessoas),
    periodos: n(p.periodos),
    contato: typeof p.contato === 'string' && p.contato.length > 0 ? p.contato : null,
  };
}

type PropostaRow = typeof propostaSdr.$inferSelect;
function propostaView(p: PropostaRow) {
  return {
    id: p.id,
    status: p.status,
    cotaCodigo: p.cotaCodigo,
    valorTabelaCentavos: p.valorTabelaCentavos,
    valorMinimoCentavos: p.valorMinimoCentavos,
    valorOfertadoCentavos: p.valorOfertadoCentavos,
    descontoBps: p.descontoBps,
    valorPedidoCentavos: p.valorPedidoCentavos,
    motivo: p.motivo,
    origem: p.origem,
    aprovadoPor: p.aprovadoPor,
    aprovadoEm: p.aprovadoEm,
    criadoEm: p.criadoEm,
    atualizadoEm: p.atualizadoEm,
  };
}

const sessoes = new WeakMap<FastifyRequest, SessaoConsole>();
const ParamsDecisao = z.object({ id: z.uuid(), pid: z.uuid() });
const BodyRecusa = z.object({
  motivo: z.string().min(3).max(280),
  /** Presente ⇒ contraproposta; ausente ⇒ recusa simples, o lead volta ao piso. */
  contrapropostaCentavos: z.number().int().positive().optional(),
});

export const leadsRoutes: FastifyPluginCallback<LeadsRoutesOpts> = (app, opts, done) => {
  const { db } = opts;

  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    const sessao = await sessaoDaRequest(opts.auth, req.headers);
    if (!sessao) return reply.code(401).send({ erro: 'não autenticado' });
    sessoes.set(req, sessao);
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ erro: 'entrada inválida', detalhe: z.prettifyError(err) });
    }
    req.log.error(err, 'erro na api de leads');
    return reply.code(500).send({ erro: 'erro interno' });
  });

  // 1 query: lead + última proposta via lateral (sem N+1, #31)
  app.get('/api/console/leads', async () => {
    const r = await db.execute(sql`
      SELECT l.id, l.wa_id, l.nome, l.status, l.perfil, l.conversa_id, l.criado_em, l.atualizado_em,
             p.id AS proposta_id, p.status AS proposta_status, p.cota_codigo,
             p.valor_tabela_centavos, p.valor_minimo_centavos, p.valor_ofertado_centavos,
             p.desconto_bps, p.valor_pedido_centavos, p.motivo AS proposta_motivo,
             p.criado_em AS proposta_em
      FROM lead l
      LEFT JOIN LATERAL (
        SELECT * FROM proposta_sdr p WHERE p.lead_id = l.id ORDER BY p.criado_em DESC LIMIT 1
      ) p ON true
      ORDER BY l.atualizado_em DESC
      LIMIT 200
    `);
    const leads = (
      r.rows as {
        id: string;
        wa_id: string;
        nome: string | null;
        status: (typeof lead.$inferSelect)['status'];
        perfil: unknown;
        conversa_id: string | null;
        criado_em: Date;
        atualizado_em: Date;
        proposta_id: string | null;
        proposta_status: PropostaRow['status'] | null;
        cota_codigo: string | null;
        valor_tabela_centavos: number | null;
        valor_minimo_centavos: number | null;
        valor_ofertado_centavos: number | null;
        desconto_bps: number | null;
        valor_pedido_centavos: number | null;
        proposta_motivo: string | null;
        proposta_em: Date | null;
      }[]
    ).map((l) => ({
      id: l.id,
      waId: l.wa_id,
      nome: l.nome,
      status: l.status,
      perfil: perfilDe(l.perfil),
      conversaId: l.conversa_id,
      criadoEm: l.criado_em,
      atualizadoEm: l.atualizado_em,
      proposta:
        l.proposta_id && l.proposta_status
          ? {
              id: l.proposta_id,
              status: l.proposta_status,
              cotaCodigo: l.cota_codigo ?? '',
              valorTabelaCentavos: l.valor_tabela_centavos ?? 0,
              valorMinimoCentavos: l.valor_minimo_centavos ?? 0,
              valorOfertadoCentavos: l.valor_ofertado_centavos ?? 0,
              descontoBps: l.desconto_bps ?? 0,
              valorPedidoCentavos: l.valor_pedido_centavos,
              motivo: l.proposta_motivo,
              criadoEm: l.proposta_em,
            }
          : null,
    }));
    return { leads };
  });

  app.get('/api/console/leads/:id', async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const [l] = await db.select().from(lead).where(eq(lead.id, id));
    if (!l) return reply.code(404).send({ erro: 'lead inexistente' });
    const [propostas, [fluxo]] = await Promise.all([
      db
        .select()
        .from(propostaSdr)
        .where(eq(propostaSdr.leadId, id))
        .orderBy(asc(propostaSdr.criadoEm)),
      db
        .select({
          etapa: fluxoSdr.etapa,
          oferta: fluxoSdr.oferta,
          encerramento: fluxoSdr.encerramento,
          atualizadoEm: fluxoSdr.atualizadoEm,
        })
        .from(fluxoSdr)
        .where(eq(fluxoSdr.leadId, id))
        .orderBy(desc(fluxoSdr.criadoEm))
        .limit(1),
    ]);
    return {
      lead: {
        id: l.id,
        waId: l.waId,
        nome: l.nome,
        status: l.status,
        origem: l.origem,
        perfil: perfilDe(l.perfil),
        conversaId: l.conversaId,
        criadoEm: l.criadoEm,
        atualizadoEm: l.atualizadoEm,
      },
      propostas: propostas.map(propostaView),
      fluxo: fluxo ?? null,
    };
  });

  // --- 015b: a decisão humana ------------------------------------------------

  const sdr = opts.sdr;
  if (!sdr) {
    done();
    return;
  }

  /**
   * Tira a proposta de `aguardando_aprovacao` com um UPDATE condicional — é a
   * trava de concorrência: dois atendentes clicando juntos, só um decide. O
   * efeito na conversa vem DEPOIS, e só para quem ganhou a corrida.
   */
  async function decidir(
    propostaId: string,
    leadId: string,
    campos: Partial<typeof propostaSdr.$inferInsert>,
  ) {
    const [linha] = await db
      .update(propostaSdr)
      .set({ ...campos, atualizadoEm: new Date() })
      .where(
        and(
          eq(propostaSdr.id, propostaId),
          eq(propostaSdr.leadId, leadId),
          eq(propostaSdr.status, 'aguardando_aprovacao'),
        ),
      )
      .returning();
    return linha ?? null;
  }

  /** O que o console decidiu vira sinal de aprendizado — o distiller lê daqui. */
  async function registrarSinal(
    conversaId: string,
    decisao: string,
    por: string,
    dados: Record<string, unknown>,
  ) {
    await db.insert(sinalAprendizado).values({
      id: newTraceId(),
      tipo: 'decisao_humana_sdr',
      conversaId,
      payload: { decisao, por, ...dados },
    });
  }

  app.post('/api/console/leads/:id/propostas/:pid/aprovar', async (req, reply) => {
    const { id, pid } = ParamsDecisao.parse(req.params);
    const sessao = sessoes.get(req);
    if (!sessao) return reply.code(401).send({ erro: 'não autenticado' });

    const proposta = await decidir(pid, id, {
      status: 'aceita',
      aprovadoPor: sessao.userId,
      aprovadoEm: new Date(),
    });
    if (!proposta) return reply.code(409).send(await porqueNao(db, pid, id));

    // o valor aprovado é o que o LEAD pediu — é isso que o humano aceitou
    const centavos = proposta.valorPedidoCentavos ?? proposta.valorOfertadoCentavos;
    await db
      .update(propostaSdr)
      .set({ valorOfertadoCentavos: centavos })
      .where(eq(propostaSdr.id, pid));
    await aplicarDecisaoHumana(sdr, proposta.conversaId, { tipo: 'aprovar_humano', centavos });
    await registrarSinal(proposta.conversaId, 'aprovada', sessao.userId, {
      propostaId: pid,
      valorCentavos: centavos,
    });
    return reply.code(202).send({ ok: true });
  });

  app.post('/api/console/leads/:id/propostas/:pid/recusar', async (req, reply) => {
    const { id, pid } = ParamsDecisao.parse(req.params);
    const body = BodyRecusa.parse(req.body);
    const sessao = sessoes.get(req);
    if (!sessao) return reply.code(401).send({ erro: 'não autenticado' });

    // a contraproposta é validada contra a proposta ORIGINAL, antes de decidir:
    // 400 por valor fora da faixa não pode consumir a aprovação pendente
    const [atual] = await db.select().from(propostaSdr).where(eq(propostaSdr.id, pid));
    if (!atual) return reply.code(404).send({ erro: 'proposta inexistente' });
    const contra = body.contrapropostaCentavos;
    if (contra !== undefined) {
      if (contra < atual.valorMinimoCentavos || contra > atual.valorTabelaCentavos) {
        return reply.code(400).send({
          erro: `contraproposta fora da faixa (${atual.valorMinimoCentavos}..${atual.valorTabelaCentavos})`,
        });
      }
    }

    const proposta = await decidir(pid, id, {
      status: 'recusada',
      motivo: body.motivo,
      aprovadoPor: sessao.userId,
      aprovadoEm: new Date(),
    });
    if (!proposta) return reply.code(409).send(await porqueNao(db, pid, id));

    if (contra === undefined) {
      await aplicarDecisaoHumana(sdr, proposta.conversaId, { tipo: 'recusar_humano' });
      await registrarSinal(proposta.conversaId, 'recusada', sessao.userId, {
        propostaId: pid,
        motivo: body.motivo,
      });
      return reply.code(202).send({ ok: true });
    }

    // contraproposta: proposta NOVA, com origem `humano` — a original fica
    // recusada, e as duas no histórico contam a negociação inteira
    const nova = await db
      .insert(propostaSdr)
      .values({
        id: newTraceId(),
        leadId: proposta.leadId,
        fluxoId: proposta.fluxoId,
        conversaId: proposta.conversaId,
        cotaId: proposta.cotaId,
        cotaCodigo: proposta.cotaCodigo,
        referencia: `${proposta.referencia}:humano:${Date.now()}`,
        valorTabelaCentavos: proposta.valorTabelaCentavos,
        valorMinimoCentavos: proposta.valorMinimoCentavos,
        valorOfertadoCentavos: contra,
        descontoBps: proposta.descontoBps,
        status: 'ofertada',
        origem: 'humano',
        aprovadoPor: sessao.userId,
        aprovadoEm: new Date(),
      })
      .returning();
    await aplicarDecisaoHumana(sdr, proposta.conversaId, {
      tipo: 'contrapropor_humano',
      centavos: contra,
    });
    await registrarSinal(proposta.conversaId, 'contraproposta', sessao.userId, {
      propostaId: pid,
      novaPropostaId: nova[0]?.id,
      valorCentavos: contra,
    });
    return reply.code(202).send({ ok: true, propostaId: nova[0]?.id });
  });

  done();
};

/** 404 × 409: a diferença entre "não existe" e "já foi decidida". */
async function porqueNao(db: Db, propostaId: string, leadId: string) {
  const [p] = await db.select().from(propostaSdr).where(eq(propostaSdr.id, propostaId));
  if (!p || p.leadId !== leadId) return { erro: 'proposta inexistente' };
  return { erro: `proposta não está aguardando aprovação (${p.status})` };
}
