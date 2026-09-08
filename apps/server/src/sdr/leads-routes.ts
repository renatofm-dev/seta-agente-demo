import { asc, desc, eq, sql } from 'drizzle-orm';
import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError, z } from 'zod';
import { type Auth, sessaoDaRequest } from '../auth.js';
import type { Db } from '../db/index.js';
import { fluxoSdr, lead, propostaSdr } from '../db/schema.js';

/**
 * Leitura dos leads da 015 para a tela Leads do console (só leitura). Aprovar,
 * recusar e contra-propor mexem no fluxo SDR e avisam o lead — ficam com a
 * 015b; aqui a tela mostra o que o agente registrou.
 */

export interface LeadsRoutesOpts {
  readonly db: Db;
  readonly auth: Auth;
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
    aprovadoPor: p.aprovadoPor,
    criadoEm: p.criadoEm,
    atualizadoEm: p.atualizadoEm,
  };
}

export const leadsRoutes: FastifyPluginCallback<LeadsRoutesOpts> = (app, opts, done) => {
  const { db } = opts;

  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    const sessao = await sessaoDaRequest(opts.auth, req.headers);
    if (!sessao) return reply.code(401).send({ erro: 'não autenticado' });
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

  done();
};
