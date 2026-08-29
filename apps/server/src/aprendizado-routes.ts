import type { AIProvider } from '@seta/ai-provider';
import type { ObsEmitter } from '@seta/observability';
import type { SkillFrontmatter, SkillRegistry } from '@seta/skills';
import { desc, sql as dsql, eq, inArray } from 'drizzle-orm';
import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError, z } from 'zod';
import { type Auth, type SessaoConsole, sessaoDaRequest } from './auth.js';
import type { Db } from './db/index.js';
import { proposta, sinalAprendizado, skill, skillVersao } from './db/schema.js';
import { gerarPropostas } from './skills/distiller.js';

/**
 * API da aba Aprendizado (009). Papel `curador` obrigatório em TODAS as rotas.
 */

export interface AprendizadoRoutesOpts {
  readonly db: Db;
  readonly auth: Auth;
  readonly registry: SkillRegistry;
  /** null ⇒ distiller indisponível (LLM não configurado). */
  readonly provider: AIProvider | null;
  /** #30: emissor p/ contabilizar os tokens do distiller (ausente ⇒ não emite). */
  readonly obs?: ObsEmitter;
}

const sessoes = new WeakMap<FastifyRequest, SessaoConsole>();

export const aprendizadoRoutes: FastifyPluginCallback<AprendizadoRoutesOpts> = (
  app,
  opts,
  done,
) => {
  const { db, auth, registry, provider } = opts;

  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    const sessao = await sessaoDaRequest(auth, req.headers);
    if (!sessao) return reply.code(401).send({ erro: 'não autenticado' });
    if (sessao.role !== 'curador') {
      return reply.code(403).send({ erro: 'papel curador obrigatório' });
    }
    sessoes.set(req, sessao);
  });
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      // #37: input inválido é 400, não 500
      return reply.code(400).send({ erro: 'entrada inválida', detalhe: z.prettifyError(err) });
    }
    req.log.error(err, 'erro na api de aprendizado');
    return reply.code(500).send({ erro: 'erro interno' });
  });
  const sessaoDe = (req: FastifyRequest): SessaoConsole => {
    const s = sessoes.get(req);
    if (!s) throw new Error('sessão ausente após preHandler');
    return s;
  };

  app.post('/api/aprendizado/gerar', async (_req, reply) => {
    if (!provider) {
      return reply.code(503).send({ erro: 'LLM não configurado — distiller indisponível' });
    }
    return gerarPropostas({ db, provider, obs: opts.obs });
  });

  app.get('/api/aprendizado/propostas', async () => {
    const abertas = await db
      .select()
      .from(proposta)
      .where(eq(proposta.status, 'aberta'))
      .orderBy(desc(proposta.criadoEm));
    return abertas.map((p) => ({
      id: p.id,
      tipo: p.tipo,
      frontmatter: p.frontmatter,
      diff: p.diff,
      evidencia: p.evidencia,
      impactoConversas: (p.evidencia as { nConversas?: number }).nConversas ?? 0,
      criadoEm: p.criadoEm,
    }));
  });

  app.post('/api/aprendizado/proposta/:id/aprovar', async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const body = z.object({ corpo: z.string().min(20).optional() }).parse(req.body ?? {});
    const sessao = sessaoDe(req);
    return registry.approve(id, sessao.email, body.corpo ? { corpo: body.corpo } : undefined);
  });

  app.post('/api/aprendizado/proposta/:id/rejeitar', async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const body = z.object({ motivo: z.string().min(3) }).parse(req.body);
    await registry.reject(id, sessaoDe(req).email, body.motivo);
    return reply.code(204).send();
  });

  app.get('/api/aprendizado/skills', async () => {
    const skills = await db.select().from(skill);
    const resultado = [];
    for (const s of skills) {
      const versoes = await db
        .select()
        .from(skillVersao)
        .where(eq(skillVersao.skillId, s.id))
        .orderBy(desc(skillVersao.versao));
      const ativa = versoes.find((v) => v.status === 'ativa') ?? null;
      const contagem = await db.execute(dsql`
        SELECT
          count(*)::int AS usos,
          count(DISTINCT tk.id) FILTER (WHERE tk.status = 'resolvido')::int AS resolucoes
        FROM trace_turno t
        LEFT JOIN ticket tk ON tk.conversa_id = t.conversa_id
        WHERE t.contexto -> 'skillIds' @> ${JSON.stringify([s.id])}::jsonb
      `);
      const metricas = (contagem.rows[0] ?? { usos: 0, resolucoes: 0 }) as {
        usos: number;
        resolucoes: number;
      };
      resultado.push({
        id: s.id,
        idLogico: s.idLogico,
        ativa: ativa
          ? {
              versaoId: ativa.id,
              versao: ativa.versao,
              descricao: (ativa.frontmatter as SkillFrontmatter).description,
              criadoPor: ativa.criadoPor,
              aprovadoPor: ativa.aprovadoPor,
            }
          : null,
        usos: metricas.usos,
        taxaResolucao: metricas.usos > 0 ? metricas.resolucoes / metricas.usos : 0,
        versoes: versoes.map((v) => ({
          id: v.id,
          versao: v.versao,
          status: v.status,
          criadoPor: v.criadoPor,
          aprovadoPor: v.aprovadoPor,
          criadoEm: v.criadoEm,
        })),
      });
    }
    return resultado;
  });

  app.post('/api/aprendizado/skill/:id/rollback', async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const body = z
      .object({ paraVersao: z.number().int().min(1), motivo: z.string().min(3) })
      .parse(req.body);
    await registry.rollback(id, body.paraVersao, body.motivo);
    req.log.info(
      { skillId: id, paraVersao: body.paraVersao, motivo: body.motivo, por: sessaoDe(req).email },
      'rollback de skill',
    );
    return reply.code(204).send();
  });

  app.post('/api/aprendizado/skill/:id/desativar', async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const body = z.object({ motivo: z.string().min(3) }).parse(req.body);
    await registry.deactivate(id, body.motivo);
    req.log.warn(
      { skillId: id, motivo: body.motivo, por: sessaoDe(req).email },
      'kill-switch de skill',
    );
    return reply.code(204).send();
  });

  /** Cadeia de auditoria: sinal → proposta → revisor → versão → turnos que usaram. */
  app.get('/api/aprendizado/skill/:id/auditoria', async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const versoes = await db
      .select()
      .from(skillVersao)
      .where(eq(skillVersao.skillId, id))
      .orderBy(desc(skillVersao.versao));
    if (versoes.length === 0) return reply.code(404).send({ erro: 'skill sem versões' });

    const cadeia = [];
    // #37: não depende da versão — era re-executada (idêntica) a cada iteração
    const turnosQueUsaram = await db.execute(dsql`
      SELECT id, turno_id, criado_em FROM trace_turno
      WHERE contexto -> 'skillIds' @> ${JSON.stringify([id])}::jsonb
      ORDER BY criado_em DESC LIMIT 20
    `);
    for (const v of versoes) {
      const [p] = v.propostaId
        ? await db.select().from(proposta).where(eq(proposta.id, v.propostaId))
        : [];
      const sinais = p
        ? await db
            .select()
            .from(sinalAprendizado)
            .where(inArray(sinalAprendizado.id, (p.sinais as string[]) ?? []))
        : [];
      cadeia.push({
        versao: {
          id: v.id,
          numero: v.versao,
          status: v.status,
          criadoPor: v.criadoPor,
          aprovadoPor: v.aprovadoPor,
          aprovadoEm: v.aprovadoEm,
        },
        proposta: p
          ? {
              id: p.id,
              tipo: p.tipo,
              status: p.status,
              revisadoPor: p.revisadoPor,
              evidencia: p.evidencia,
            }
          : null,
        sinais: sinais.map((s) => ({ id: s.id, tipo: s.tipo, criadoEm: s.criadoEm })),
        turnosQueUsaram: turnosQueUsaram.rows,
      });
    }
    return { skillId: id, cadeia };
  });

  done();
};
