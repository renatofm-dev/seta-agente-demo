import {
  createAgentRuntime,
  type ResultadoTurno,
  TEXTO_FALLBACK,
  TEXTO_TRANSICAO,
  type TraceEvento,
  toolEscalarParaHumano,
} from '@seta/agent';
import type { AIProvider, ChatMessage } from '@seta/ai-provider';
import type { ClientConfig } from '@seta/client-config';
import { classificarIntencao, guardrailPreco, TRIGGER_POR_INTENCAO } from '@seta/guardrails';
import { newTraceId, type ObsEmitter } from '@seta/observability';
import { buildToolSpecs, type CatalogIndex, type Executor } from '@seta/query-catalog';
import type { VectorStore } from '@seta/rag';
import type { SkillRegistry } from '@seta/skills';
import { and, desc, eq, isNull, ne, or, sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import type { Logger } from 'pino';
import type { Db } from '../db/index.js';
import { contato, conversa, mensagem, sinalAprendizado, ticket, traceTurno } from '../db/schema.js';
import { toolBuscarConhecimento } from '../rag/tool-buscar-conhecimento.js';
import type { TurnoHandler, TurnoPronto } from './debounce.js';
import { enqueueOutbound } from './outbox.js';
import { aplicarTransicao, garantirTicket } from './tickets.js';

/**
 * Handler real do turno (substitui o stub da 004): monta o contexto da conversa,
 * roda o grafo do agente e persiste trace_turno SEMPRE — mesmo quando o LLM não
 * está configurado ou o grafo falha.
 */

export interface AgentTurnoHandlerDeps {
  readonly db: Db;
  readonly boss: PgBoss;
  /** null ⇒ LLM não configurado; turno responde fallback honesto. */
  readonly provider: AIProvider | null;
  readonly catalog: CatalogIndex;
  readonly executor: Executor;
  readonly clientConfig: ClientConfig;
  /** null ⇒ turno roda sem skills (009). */
  readonly registry: SkillRegistry | null;
  /** VectorStore da KB (008) — buscar_conhecimento real. */
  readonly store: VectorStore;
  /** Emissor de eventos de observabilidade (010) — fire-and-forget, nunca lança. */
  readonly obs: ObsEmitter;
  readonly logger: Logger;
  readonly turnoTimeoutMs: number;
  readonly resumoACadaTurnos: number;
}

export function createAgentTurnoHandler(deps: AgentTurnoHandlerDeps): TurnoHandler {
  return {
    async processar(t: TurnoPronto): Promise<void> {
      const traceId = newTraceId();
      const inicio = Date.now();
      try {
        const resultado = await processarComAgente(deps, t, traceId);
        if (resultado.escalado) {
          await escalarTicket(deps, t, resultado);
        }
        await gravarSinaisDeVerdict(deps, t, resultado);
        emitirObservabilidade(deps, t, traceId, resultado, await ticketIdDe(deps.db, t));
        // trace por ÚLTIMO: é o marcador de turno completo (ticket e sinais já visíveis)
        await gravarTrace(deps.db, t, traceId, resultado);
      } catch (err) {
        // trace persistido SEMPRE — inclusive na falha catastrófica do runtime
        deps.logger.error({ err, turnoId: t.id, traceId }, 'turno falhou — fallback de emergência');
        const eventos: TraceEvento[] = [
          {
            tipo: 'fallback',
            motivo: `erro no runtime: ${err instanceof Error ? err.message : err}`,
          },
        ];
        await enqueueOutbound(
          { db: deps.db, boss: deps.boss },
          { conversaId: t.conversaId, turnoId: t.id, seq: 1, texto: TEXTO_FALLBACK },
        );
        await gravarTrace(deps.db, t, traceId, {
          resposta: TEXTO_FALLBACK,
          escalado: false,
          escaladoTrigger: null,
          fallback: true,
          fallbackMotivo: 'erro no runtime',
          eventos,
          tokensEntrada: 0,
          tokensSaida: 0,
          latenciaMs: Date.now() - inicio,
        }).catch((e) => {
          // último recurso: nunca deixar o job re-tentar por falha do próprio trace
          deps.logger.error({ e, turnoId: t.id }, 'falha ao gravar trace de emergência');
        });
      }
    },
  };
}

async function processarComAgente(
  deps: AgentTurnoHandlerDeps,
  t: TurnoPronto,
  traceId: string,
): Promise<ResultadoTurno> {
  const [conv] = await deps.db.select().from(conversa).where(eq(conversa.id, t.conversaId));
  if (!conv) throw new Error(`turno ${t.id} sem conversa`);

  // vínculo verificado vem da tabela contato (seed grava — corte da 000)
  const [vinculo] = await deps.db.select().from(contato).where(eq(contato.waId, conv.waId));
  const clienteId = vinculo?.clienteErpId ?? '';
  const session = { traceId, clienteId };

  const inicioTurno = Date.now();
  // #30: tokens de TODA chamada do turno (classificador + resumo) entram no
  // trace e no evento_llm — o custo do /metricas deixa de subcontar
  const usageExtra = { entrada: 0, saida: 0 };
  const efeitos = {
    gravarResposta: async (texto: string) => {
      await enqueueOutbound(
        { db: deps.db, boss: deps.boss },
        { conversaId: t.conversaId, turnoId: t.id, seq: 1, texto },
      );
    },
    atualizarResumoSePreciso: async () => {
      const uso = await atualizarResumo(deps, conv.id);
      usageExtra.entrada += uso.tokensEntrada;
      usageExtra.saida += uso.tokensSaida;
    },
  };

  if (!deps.provider) {
    await efeitos.gravarResposta(TEXTO_FALLBACK);
    return {
      resposta: TEXTO_FALLBACK,
      escalado: false,
      escaladoTrigger: null,
      fallback: true,
      fallbackMotivo: 'LLM não configurado (LLM_BASE_URL/LLM_API_KEY/LLM_MODEL)',
      eventos: [{ tipo: 'fallback', motivo: 'LLM não configurado' }],
      tokensEntrada: 0,
      tokensSaida: 0,
      latenciaMs: 0,
    };
  }

  // guardrail de intenção (006): classificação curta ANTES de o agente responder
  const cls = await classificarIntencao(
    deps.provider,
    t.textoAgregado,
    deps.clientConfig.guardrails.temasSensiveis,
  ).catch(() => ({ intencao: 'outro' as const, tokensEntrada: 0, tokensSaida: 0 }));
  const intencao = cls.intencao;
  usageExtra.entrada += cls.tokensEntrada;
  usageExtra.saida += cls.tokensSaida;
  if (intencao !== 'outro') {
    const trigger = TRIGGER_POR_INTENCAO[intencao];
    await efeitos.gravarResposta(TEXTO_TRANSICAO);
    return {
      resposta: TEXTO_TRANSICAO,
      escalado: true,
      escaladoTrigger: trigger,
      fallback: false,
      fallbackMotivo: null,
      eventos: [
        {
          tipo: 'verdict',
          guardrail: 'classificador_intencao',
          hook: 'beforeReply',
          verdict: { tipo: 'escalate', trigger, reason: `intenção classificada: ${intencao}` },
        },
        { tipo: 'escalado' },
      ],
      tokensEntrada: usageExtra.entrada,
      tokensSaida: usageExtra.saida,
      latenciaMs: Date.now() - inicioTurno, // latência REAL — 0 distorcia o p95
    };
  }

  // as N mais RECENTES, em ordem cronológica; turno_id IS NULL (mensagem manual
  // do atendente) também entra — ne() sozinho descartaria essas linhas (NULL <> x)
  const historicoDb = await deps.db
    .select()
    .from(mensagem)
    .where(
      and(
        eq(mensagem.conversaId, conv.id),
        or(isNull(mensagem.turnoId), ne(mensagem.turnoId, t.id)),
      ),
    )
    .orderBy(desc(mensagem.criadoEm))
    .limit(deps.clientConfig.limites.maxMensagensContexto);
  historicoDb.reverse();
  const historico: ChatMessage[] = historicoDb.map((m) => ({
    role: m.direcao === 'in' ? ('user' as const) : ('assistant' as const),
    content: m.texto,
  }));

  const provider = deps.provider;
  const tools = [
    ...buildToolSpecs(deps.catalog, deps.executor, {
      modulosHabilitados: deps.clientConfig.modulos,
      temVinculo: clienteId !== '', // #35: sem vínculo, tools de dado nem aparecem
    }),
    toolBuscarConhecimento({
      store: deps.store,
      embed: (texto) => provider.embed([texto]).then((v) => Array.from(v[0] ?? [])),
    }),
    toolEscalarParaHumano(),
  ];

  // skills top-2 no contexto (009); ids entram no trace p/ atribuição de uso
  let skills: { id: string; conteudo: string }[] = [];
  if (deps.registry) {
    const embedding = await deps.provider
      .embed([t.textoAgregado])
      .then((v) => Array.from(v[0] ?? []))
      .catch(() => undefined);
    const ativas = await deps.registry
      .activeFor({ texto: t.textoAgregado, ...(embedding?.length ? { embedding } : {}) }, 2)
      .catch((err) => {
        deps.logger.warn({ err }, 'retrieval de skills falhou — turno segue sem skills (#32)');
        return [];
      });
    skills = ativas.map((sk) => ({
      id: sk.skillId,
      conteudo: `## ${sk.idLogico} (v${sk.versao})\n${sk.doc.corpo}`,
    }));
  }

  const runtime = createAgentRuntime({
    provider: deps.provider,
    guardrails: [guardrailPreco()],
  });
  const resultado = await runtime.processarTurno({
    session,
    persona: deps.clientConfig.persona,
    resumo: conv.resumo,
    skills,
    historico,
    textoUsuario: t.textoAgregado,
    tools,
    limites: {
      maxToolCalls: deps.clientConfig.limites.maxToolCallsPorTurno,
      timeoutMs: deps.turnoTimeoutMs,
      retriesPorTool: 1,
    },
    efeitos,
  });
  return {
    ...resultado,
    tokensEntrada: resultado.tokensEntrada + usageExtra.entrada,
    tokensSaida: resultado.tokensSaida + usageExtra.saida,
  };
}

/** Escalada do bot (007): ticket → aguardando_humano com o motivo da tool. */
async function ticketIdDe(db: Db, t: TurnoPronto): Promise<string | null> {
  const [tk] = await db
    .select({ id: ticket.id })
    .from(ticket)
    .where(eq(ticket.conversaId, t.conversaId))
    .limit(1);
  return tk?.id ?? null;
}

/**
 * Emissão da 010 (fire-and-forget dentro do emitter): 1 evento_llm por turno
 * com o usage agregado, 1 evento_guardrail por verdict e 1 evento_escalonamento
 * quando o turno escala — todos com traceId e ticketId (quando existe).
 */
function emitirObservabilidade(
  deps: AgentTurnoHandlerDeps,
  t: TurnoPronto,
  traceId: string,
  resultado: ResultadoTurno,
  ticketId: string | null,
): void {
  const base = { traceId, conversaId: t.conversaId, turnoId: t.id, ticketId };

  if (deps.provider) {
    deps.obs.llm({
      ...base,
      modelo: deps.provider.modelId,
      tokensEntrada: resultado.tokensEntrada,
      tokensSaida: resultado.tokensSaida,
      latenciaMs: resultado.latenciaMs,
    });
  }

  const verdicts = resultado.eventos.filter((e) => e.tipo === 'verdict');
  for (const v of verdicts) {
    const hook = v.hook === 'beforeTool' || v.hook === 'afterTool' ? v.hook : 'beforeReply';
    deps.obs.guardrail({
      ...base,
      guardrail: v.guardrail,
      hook,
      verdict: v.verdict.tipo,
      motivo:
        v.verdict.tipo === 'block' || v.verdict.tipo === 'escalate'
          ? (v.verdict.reason ?? null)
          : null,
    });
  }

  if (resultado.escalado) {
    const escalate = verdicts.find((v) => v.verdict.tipo === 'escalate');
    const origem = escalate
      ? escalate.guardrail === 'classificador_intencao'
        ? 'intencao'
        : 'guardrail'
      : resultado.fallbackMotivo?.includes('falhas de tool')
        ? 'falha_tool'
        : 'agente';
    deps.obs.escalonamento({
      ...base,
      motivo: resultado.escaladoTrigger ?? 'pedido_do_agente',
      origem,
    });
  }
}

async function escalarTicket(
  deps: AgentTurnoHandlerDeps,
  t: TurnoPronto,
  resultado: ResultadoTurno,
): Promise<void> {
  const atual = await garantirTicket(deps.db, t.conversaId);
  if (atual.status !== 'bot_ativo') return; // já escalado/atendido — nada a fazer
  const evTool = resultado.eventos.find(
    (e) => e.tipo === 'tool' && e.nome === 'escalar_para_humano',
  );
  const motivoTool =
    evTool?.tipo === 'tool' && typeof evTool.params.motivo === 'string'
      ? evTool.params.motivo
      : null;
  // motivo textual da tool > trigger do guardrail > motivo do fallback
  const motivo =
    motivoTool ?? resultado.escaladoTrigger ?? resultado.fallbackMotivo ?? 'escalado pelo agente';
  await aplicarTransicao(deps.db, atual, 'aguardando_humano', 'bot', { motivo });
  // escalonamento também é sinal de aprendizado (009)
  await deps.db.insert(sinalAprendizado).values({
    id: newTraceId(),
    tipo: 'escalonamento',
    ticketId: atual.id,
    conversaId: t.conversaId,
    payload: {
      refId: t.id,
      motivo,
      trigger: resultado.escaladoTrigger,
      textoUsuario: t.textoAgregado,
    },
  });
}

/** 006: todo verdict != allow do turno vira sinal_aprendizado (a 009 consome). */
async function gravarSinaisDeVerdict(
  deps: AgentTurnoHandlerDeps,
  t: TurnoPronto,
  resultado: ResultadoTurno,
): Promise<void> {
  const verdicts = resultado.eventos.filter((e) => e.tipo === 'verdict');
  for (const v of verdicts) {
    if (v.tipo !== 'verdict') continue;
    await deps.db.insert(sinalAprendizado).values({
      id: newTraceId(),
      tipo: 'guardrail_verdict',
      conversaId: t.conversaId,
      payload: {
        guardrail: v.guardrail,
        hook: v.hook,
        verdict: v.verdict,
        textoUsuario: t.textoAgregado,
        resposta: resultado.resposta,
        turnoId: t.id,
      },
    });
  }
}

/** Sumarização barata a cada K turnos (uma chamada curta ao provider). */
const SEM_USO = { tokensEntrada: 0, tokensSaida: 0 } as const;
const TIMEOUT_RESUMO_MS = 20_000;

async function atualizarResumo(
  deps: AgentTurnoHandlerDeps,
  conversaId: string,
): Promise<{ tokensEntrada: number; tokensSaida: number }> {
  const [conv] = await deps.db
    .update(conversa)
    .set({ turnosDesdeResumo: sql`${conversa.turnosDesdeResumo} + 1` })
    .where(eq(conversa.id, conversaId))
    .returning();
  if (!conv || !deps.provider || conv.turnosDesdeResumo < deps.resumoACadaTurnos) return SEM_USO;

  const ultimas = await deps.db
    .select()
    .from(mensagem)
    .where(eq(mensagem.conversaId, conversaId))
    .orderBy(desc(mensagem.criadoEm)) // as mais recentes — senão o resumo nunca avança
    .limit(deps.clientConfig.limites.maxMensagensContexto);
  ultimas.reverse();
  const transcricao = ultimas
    .map((m) => `${m.direcao === 'in' ? 'Cliente' : 'Agente'}: ${m.texto}`)
    .join('\n');

  try {
    const res = await deps.provider.chat({
      signal: AbortSignal.timeout(TIMEOUT_RESUMO_MS), // pendurado não segura o turno (#27)
      messages: [
        {
          role: 'system',
          content:
            'Resuma a conversa a seguir em até 5 linhas, em português, guardando fatos úteis ' +
            'para o atendimento continuar (pedidos citados, boletos, pendências, tom do cliente).',
        },
        {
          role: 'user',
          content: `Resumo anterior:\n${conv.resumo ?? '(nenhum)'}\n\n${transcricao}`,
        },
      ],
      maxOutputTokens: 300,
    });
    if (res.content) {
      await deps.db
        .update(conversa)
        .set({ resumo: res.content, turnosDesdeResumo: 0 })
        .where(eq(conversa.id, conversaId));
    }
    return { tokensEntrada: res.tokensEntrada, tokensSaida: res.tokensSaida };
  } catch (err) {
    deps.logger.warn({ err, conversaId }, 'sumarização do resumo falhou — segue sem atualizar');
    return SEM_USO;
  }
}

async function gravarTrace(
  db: Db,
  t: TurnoPronto,
  traceId: string,
  r: ResultadoTurno,
): Promise<void> {
  // turnos sem nó de contexto (ex.: escalada pelo classificador) gravam {}
  const contexto = r.eventos.find((e) => e.tipo === 'contexto') ?? {};
  await db.insert(traceTurno).values({
    id: newTraceId(),
    turnoId: t.id,
    conversaId: t.conversaId,
    traceId,
    contexto,
    eventos: r.eventos,
    resposta: r.resposta,
    escalado: r.escalado,
    fallback: r.fallback,
    fallbackMotivo: r.fallbackMotivo,
    tokensEntrada: r.tokensEntrada,
    tokensSaida: r.tokensSaida,
    latenciaMs: r.latenciaMs,
  });
}
