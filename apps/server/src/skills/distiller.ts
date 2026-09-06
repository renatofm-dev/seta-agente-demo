import type { AIProvider } from '@seta/ai-provider';
import { newTraceId, type ObsEmitter } from '@seta/observability';
import { DISTILLER_OUTPUT_SCHEMA, renderPromptDistiller } from '@seta/skills';
import { and, desc, eq, inArray, isNull, ne } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { casoEval, proposta, sinalAprendizado, traceTurno } from '../db/schema.js';

/**
 * Distiller on-demand (009): agrupa sinais não processados, roda o prompt de
 * destilação (saída estruturada Zod) e cria propostas com evidência + caso_eval.
 */

export interface DistillerDeps {
  readonly db: Db;
  readonly provider: AIProvider;
  /** #30: cada chamada do distiller entra no evento_llm (custo real no /metricas). */
  readonly obs?: ObsEmitter;
}

type Sinal = typeof sinalAprendizado.$inferSelect;

/** Cluster simples da POC: tipo + chave do payload (motivo/trigger/guardrail). */
function chaveCluster(s: Sinal): string {
  const p = s.payload as Record<string, unknown>;
  const detalhe =
    (typeof p.motivoEscalonamento === 'string' && p.motivoEscalonamento) ||
    (typeof p.motivo === 'string' && p.motivo) ||
    (typeof (p.verdict as { trigger?: string } | undefined)?.trigger === 'string' &&
      (p.verdict as { trigger: string }).trigger) ||
    'geral';
  return `${s.tipo}:${detalhe}`;
}

export interface ResultadoDistiller {
  readonly clusters: number;
  readonly propostasCriadas: number;
  readonly sinaisProcessados: number;
}

export async function gerarPropostas(deps: DistillerDeps): Promise<ResultadoDistiller> {
  const { db, provider } = deps;
  const traceIdRodada = newTraceId(); // agrupa os evento_llm desta rodada
  // #36: rejeicao_proposta é feedback de curadoria — auditável, mas não pode
  // voltar ao clustering (regeraria proposta parecida da que o curador negou)
  const pendentes = await db
    .select()
    .from(sinalAprendizado)
    .where(
      and(isNull(sinalAprendizado.processadoEm), ne(sinalAprendizado.tipo, 'rejeicao_proposta')),
    )
    .orderBy(desc(sinalAprendizado.criadoEm))
    .limit(200);
  if (pendentes.length === 0) {
    return { clusters: 0, propostasCriadas: 0, sinaisProcessados: 0 };
  }

  const clusters = new Map<string, Sinal[]>();
  for (const s of pendentes) {
    const chave = chaveCluster(s);
    clusters.set(chave, [...(clusters.get(chave) ?? []), s]);
  }

  let propostasCriadas = 0;
  let sinaisProcessados = 0;
  for (const [chave, sinais] of clusters) {
    const resumoSinais = sinais.slice(0, 10).map((s) => ({
      tipo: s.tipo,
      payload: s.payload,
      criadoEm: s.criadoEm.toISOString(),
    }));
    const t0 = Date.now();
    const res = await provider.chat({
      messages: [{ role: 'user', content: renderPromptDistiller(resumoSinais) }],
      temperature: 0,
      maxOutputTokens: 1024,
      traceId: traceIdRodada,
      // 016: skill destilada fica com [NOME_1] — generaliza e não grava PII na proposta
      anonimizacao: { destokenizar: false },
    });
    deps.obs?.llm({
      traceId: traceIdRodada,
      conversaId: null, // destilação não pertence a uma conversa
      turnoId: null,
      ticketId: null,
      modelo: provider.modelId,
      tokensEntrada: res.tokensEntrada,
      tokensSaida: res.tokensSaida,
      latenciaMs: Date.now() - t0,
    });
    const parsed = DISTILLER_OUTPUT_SCHEMA.safeParse(extrairJson(res.content ?? ''));
    if (!parsed.success) {
      // #36: saída inválida (transiente) NÃO consome os sinais — ficam
      // pendentes p/ a próxima rodada em vez de sumirem sem virar proposta
      continue;
    }
    if (!parsed.data.proposta) {
      // decisão deliberada do distiller ("nada a propor"): consome os sinais
      await db
        .update(sinalAprendizado)
        .set({ processadoEm: new Date() })
        .where(
          inArray(
            sinalAprendizado.id,
            sinais.map((s) => s.id),
          ),
        );
      sinaisProcessados += sinais.length;
      continue;
    }
    const p = parsed.data.proposta;

    const conversaId = sinais[0]?.conversaId;
    const propostaId = newTraceId();
    // #36: proposta + caso_eval + marcação dos sinais são ATÔMICOS por cluster —
    // crash no meio da rodada não duplica propostas na execução seguinte
    await db.transaction(async (tx) => {
      await tx.insert(proposta).values({
        id: propostaId,
        tipo: 'skill_novo',
        diff: p.corpo,
        frontmatter: {
          name: p.name,
          description: p.description,
          'x-seta': {
            escopo: 'local',
            gatilho: p.gatilho,
            tools: p.tools,
            metricas: { usos: 0, resolucoes: 0 },
            proveniencia: 'distiller',
          },
        },
        evidencia: {
          cluster: chave,
          nSinais: sinais.length,
          nConversas: new Set(sinais.map((s) => s.conversaId)).size,
          conversaId,
          trechos: resumoSinais.slice(0, 3),
        },
        sinais: sinais.map((s) => s.id),
      });
      propostasCriadas += 1;

      // toda proposta gera um caso_eval do trace real (spec 009)
      const [trace] = conversaId
        ? await tx
            .select()
            .from(traceTurno)
            .where(eq(traceTurno.conversaId, conversaId))
            .orderBy(desc(traceTurno.criadoEm))
            .limit(1)
        : [];
      const payload0 = (sinais[0]?.payload ?? {}) as {
        textoUsuario?: string;
        respostaHumano?: string;
      };
      await tx.insert(casoEval).values({
        id: newTraceId(),
        input: payload0.textoUsuario ?? p.gatilho,
        comportamentoEsperado: payload0.respostaHumano ?? p.description,
        origem: { propostaId, traceTurnoId: trace?.id ?? null },
      });
      await tx
        .update(sinalAprendizado)
        .set({ processadoEm: new Date() })
        .where(
          inArray(
            sinalAprendizado.id,
            sinais.map((s) => s.id),
          ),
        );
    });
    sinaisProcessados += sinais.length;
  }

  return {
    clusters: clusters.size,
    propostasCriadas,
    sinaisProcessados,
  };
}

/** O modelo pode devolver o JSON dentro de cerca ```json — extrai com tolerância. */
function extrairJson(texto: string): unknown {
  const m = texto.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}
