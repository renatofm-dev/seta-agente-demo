import {
  createAgentRuntime,
  type ResultadoTurno,
  TEXTO_FALLBACK,
  type TraceEvento,
  toolBuscarConhecimentoStub,
  toolEscalarParaHumano,
} from '@seta/agent';
import type { AIProvider, ChatMessage } from '@seta/ai-provider';
import type { ClientConfig } from '@seta/client-config';
import { newTraceId } from '@seta/observability';
import { buildToolSpecs, type CatalogIndex, type Executor } from '@seta/query-catalog';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import type { Logger } from 'pino';
import type { Db } from '../db/index.js';
import { conversa, mensagem, traceTurno } from '../db/schema.js';
import type { TurnoHandler, TurnoPronto } from './debounce.js';
import { enqueueOutbound } from './outbox.js';
import type { Vinculos } from './vinculo.js';

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
  readonly vinculos: Vinculos;
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
          fallback: true,
          fallbackMotivo: 'erro no runtime',
          eventos,
          tokensEntrada: 0,
          tokensSaida: 0,
          latenciaMs: Date.now() - inicio,
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

  // NOTA(007): quando o ticket existir, runtime não responde se status != bot ativo.
  const clienteId = deps.vinculos.get(conv.waId) ?? '';
  const session = { traceId, clienteId };

  const efeitos = {
    gravarResposta: async (texto: string) => {
      await enqueueOutbound(
        { db: deps.db, boss: deps.boss },
        { conversaId: t.conversaId, turnoId: t.id, seq: 1, texto },
      );
    },
    atualizarResumoSePreciso: async () => {
      await atualizarResumo(deps, conv.id);
    },
  };

  if (!deps.provider) {
    await efeitos.gravarResposta(TEXTO_FALLBACK);
    return {
      resposta: TEXTO_FALLBACK,
      escalado: false,
      fallback: true,
      fallbackMotivo: 'LLM não configurado (LLM_BASE_URL/LLM_API_KEY/LLM_MODEL)',
      eventos: [{ tipo: 'fallback', motivo: 'LLM não configurado' }],
      tokensEntrada: 0,
      tokensSaida: 0,
      latenciaMs: 0,
    };
  }

  const historicoDb = await deps.db
    .select()
    .from(mensagem)
    .where(and(eq(mensagem.conversaId, conv.id), ne(mensagem.turnoId, t.id)))
    .orderBy(asc(mensagem.criadoEm))
    .limit(deps.clientConfig.limites.maxMensagensContexto);
  const historico: ChatMessage[] = historicoDb.map((m) => ({
    role: m.direcao === 'in' ? ('user' as const) : ('assistant' as const),
    content: m.texto,
  }));

  const tools = [
    ...buildToolSpecs(deps.catalog, deps.executor, {
      modulosHabilitados: deps.clientConfig.modulos,
    }),
    toolBuscarConhecimentoStub(),
    toolEscalarParaHumano(),
  ];

  const runtime = createAgentRuntime({ provider: deps.provider });
  return runtime.processarTurno({
    session,
    persona: deps.clientConfig.persona,
    resumo: conv.resumo,
    skills: [], // top-k chega na 009
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
}

/** Sumarização barata a cada K turnos (uma chamada curta ao provider). */
async function atualizarResumo(deps: AgentTurnoHandlerDeps, conversaId: string): Promise<void> {
  const [conv] = await deps.db
    .update(conversa)
    .set({ turnosDesdeResumo: sql`${conversa.turnosDesdeResumo} + 1` })
    .where(eq(conversa.id, conversaId))
    .returning();
  if (!conv || !deps.provider || conv.turnosDesdeResumo < deps.resumoACadaTurnos) return;

  const ultimas = await deps.db
    .select()
    .from(mensagem)
    .where(eq(mensagem.conversaId, conversaId))
    .orderBy(asc(mensagem.criadoEm))
    .limit(deps.clientConfig.limites.maxMensagensContexto);
  const transcricao = ultimas
    .map((m) => `${m.direcao === 'in' ? 'Cliente' : 'Agente'}: ${m.texto}`)
    .join('\n');

  try {
    const res = await deps.provider.chat({
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
  } catch (err) {
    deps.logger.warn({ err, conversaId }, 'sumarização do resumo falhou — segue sem atualizar');
  }
}

async function gravarTrace(
  db: Db,
  t: TurnoPronto,
  traceId: string,
  r: ResultadoTurno,
): Promise<void> {
  const contexto = r.eventos.find((e) => e.tipo === 'contexto') ?? null;
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
