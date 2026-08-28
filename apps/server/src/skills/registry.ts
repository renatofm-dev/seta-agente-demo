import { newTraceId } from '@seta/observability';
import {
  cosine,
  overlapTermos,
  parseSkillMd,
  type SkillAtiva,
  type SkillDoc,
  type SkillFrontmatter,
  type SkillRegistry,
  serializeSkillMd,
} from '@seta/skills';
import { and, desc, sql as dsql, eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { proposta, sinalAprendizado, skill, skillVersao, traceTurno } from '../db/schema.js';

/**
 * Implementação drizzle do SkillRegistry (009). Versões imutáveis: toda
 * aprovação cria versão nova; só uma `ativa` por skill; kill-switch arquiva.
 */

export interface RegistryDeps {
  readonly db: Db;
  /** Gera embedding do texto; null quando EMBEDDING_MODEL não configurado. */
  readonly embed: ((texto: string) => Promise<number[]>) | null;
}

const BOOST_METRICA = 0.1;

export function createSkillRegistry(deps: RegistryDeps): SkillRegistry & {
  criarSkillComVersaoAtiva(
    doc: SkillDoc,
    criadoPor: 'distiller' | 'humano',
  ): Promise<{ skillId: string; versaoId: string }>;
} {
  const { db } = deps;

  async function embeddingDe(texto: string): Promise<number[] | null> {
    if (!deps.embed) return null;
    try {
      return await deps.embed(texto);
    } catch {
      return null; // retrieval cai no fallback por termos
    }
  }

  async function taxaResolucao(skillId: string): Promise<number> {
    // uso = trace com o skill no contexto; resolução = turno de conversa cujo ticket resolveu
    const usos = await db
      .select({ conversaId: traceTurno.conversaId })
      .from(traceTurno)
      .where(dsql`${traceTurno.contexto} -> 'skillIds' @> ${JSON.stringify([skillId])}::jsonb`);
    if (usos.length === 0) return 0;
    const resolvidas = await db.execute(dsql`
      SELECT count(DISTINCT t.conversa_id)::int AS n
      FROM trace_turno t
      JOIN ticket tk ON tk.conversa_id = t.conversa_id AND tk.status = 'resolvido'
      WHERE t.contexto -> 'skillIds' @> ${JSON.stringify([skillId])}::jsonb
    `);
    const n = (resolvidas.rows[0] as { n: number } | undefined)?.n ?? 0;
    return n / new Set(usos.map((u) => u.conversaId)).size;
  }

  async function proximaVersao(skillId: string): Promise<number> {
    const [ultima] = await db
      .select({ versao: skillVersao.versao })
      .from(skillVersao)
      .where(eq(skillVersao.skillId, skillId))
      .orderBy(desc(skillVersao.versao))
      .limit(1);
    return (ultima?.versao ?? 0) + 1;
  }

  async function arquivarAtiva(skillId: string): Promise<void> {
    await db
      .update(skillVersao)
      .set({ status: 'arquivada' })
      .where(and(eq(skillVersao.skillId, skillId), eq(skillVersao.status, 'ativa')));
  }

  async function inserirVersaoAtiva(
    skillId: string,
    doc: SkillDoc,
    extras: {
      criadoPor: 'distiller' | 'humano';
      aprovadoPor?: string;
      propostaId?: string;
    },
  ): Promise<string> {
    await arquivarAtiva(skillId);
    const id = newTraceId();
    await db.insert(skillVersao).values({
      id,
      skillId,
      versao: await proximaVersao(skillId),
      corpo: doc.corpo,
      frontmatter: doc.frontmatter,
      embedding: await embeddingDe(
        `${doc.frontmatter.description}\n${doc.frontmatter['x-seta'].gatilho}\n${doc.corpo}`,
      ),
      status: 'ativa',
      criadoPor: extras.criadoPor,
      aprovadoPor: extras.aprovadoPor ?? null,
      aprovadoEm: extras.aprovadoPor ? new Date() : null,
      propostaId: extras.propostaId ?? null,
    });
    return id;
  }

  return {
    async criarSkillComVersaoAtiva(doc, criadoPor) {
      const idLogico = doc.frontmatter.name;
      const [existente] = await db.select().from(skill).where(eq(skill.idLogico, idLogico));
      const skillId = existente?.id ?? newTraceId();
      if (!existente) {
        await db.insert(skill).values({ id: skillId, idLogico });
      }
      const versaoId = await inserirVersaoAtiva(skillId, doc, { criadoPor });
      return { skillId, versaoId };
    },

    async activeFor(ctx, k) {
      const ativas = await db
        .select({
          skillId: skillVersao.skillId,
          versaoId: skillVersao.id,
          versao: skillVersao.versao,
          corpo: skillVersao.corpo,
          frontmatter: skillVersao.frontmatter,
          embedding: skillVersao.embedding,
          idLogico: skill.idLogico,
        })
        .from(skillVersao)
        .innerJoin(skill, eq(skill.id, skillVersao.skillId))
        .where(eq(skillVersao.status, 'ativa'));

      const pontuadas: SkillAtiva[] = [];
      for (const v of ativas) {
        const fm = v.frontmatter as SkillFrontmatter;
        const referencia = `${fm.description} ${fm['x-seta'].gatilho}`;
        const emb = v.embedding as number[] | null;
        const similaridade =
          ctx.embedding && emb ? cosine(ctx.embedding, emb) : overlapTermos(ctx.texto, referencia);
        const score = similaridade + BOOST_METRICA * (await taxaResolucao(v.skillId));
        pontuadas.push({
          skillId: v.skillId,
          idLogico: v.idLogico,
          versaoId: v.versaoId,
          versao: v.versao,
          doc: { frontmatter: fm, corpo: v.corpo },
          score,
        });
      }
      return pontuadas
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, k);
    },

    async approve(propostaId, revisor, edits) {
      const [p] = await db.select().from(proposta).where(eq(proposta.id, propostaId));
      if (!p) throw new Error(`proposta inexistente: ${propostaId}`);
      if (p.status !== 'aberta') throw new Error(`proposta ${propostaId} já ${p.status}`);

      const fm = p.frontmatter as SkillFrontmatter;
      const doc: SkillDoc = { frontmatter: fm, corpo: edits?.corpo ?? p.diff };
      parseSkillMd(serializeSkillMd(doc)); // valida formato antes de gravar

      const idLogico = fm.name;
      const [existente] = await db.select().from(skill).where(eq(skill.idLogico, idLogico));
      const skillId = p.skillId ?? existente?.id ?? newTraceId();
      if (!existente && !p.skillId) {
        await db.insert(skill).values({ id: skillId, idLogico });
      }
      const versaoId = await inserirVersaoAtiva(skillId, doc, {
        criadoPor: 'distiller',
        aprovadoPor: revisor,
        propostaId,
      });
      await db
        .update(proposta)
        .set({ status: 'aprovada', revisadoPor: revisor })
        .where(eq(proposta.id, propostaId));
      return { versaoId };
    },

    async reject(propostaId, revisor, motivo) {
      const [p] = await db.select().from(proposta).where(eq(proposta.id, propostaId));
      if (!p) throw new Error(`proposta inexistente: ${propostaId}`);
      await db
        .update(proposta)
        .set({ status: 'rejeitada', motivoRejeicao: motivo, revisadoPor: revisor })
        .where(eq(proposta.id, propostaId));
      // o motivo da rejeição também é sinal de aprendizado (spec 009)
      const conversaId = (p.evidencia as { conversaId?: string }).conversaId;
      if (conversaId) {
        await db.insert(sinalAprendizado).values({
          id: newTraceId(),
          tipo: 'guardrail_verdict',
          conversaId,
          payload: { origem: 'rejeicao_proposta', propostaId, motivo, revisor },
        });
      }
    },

    async rollback(skillId, paraVersao, motivo) {
      const [alvo] = await db
        .select()
        .from(skillVersao)
        .where(and(eq(skillVersao.skillId, skillId), eq(skillVersao.versao, paraVersao)));
      if (!alvo) throw new Error(`versão ${paraVersao} inexistente para skill ${skillId}`);
      await arquivarAtiva(skillId);
      // imutável: só o status muda; autoria original da versão é preservada
      await db.update(skillVersao).set({ status: 'ativa' }).where(eq(skillVersao.id, alvo.id));
      void motivo; // motivo vai no log estruturado da rota
    },

    async deactivate(skillId, motivo) {
      await arquivarAtiva(skillId);
      void motivo; // auditoria fica no evento da rota (log estruturado)
    },
  };
}
