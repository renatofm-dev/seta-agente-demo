import type { AIProvider, ChatMessage } from '@seta/ai-provider';
import type { GuardrailHooks, Verdict } from '@seta/guardrails';
import type { SessionCtx, ToolSpec } from '@seta/query-catalog';

/** Evento do trace do turno — persistido SEMPRE (trace_turno). */
export type TraceEvento =
  | {
      tipo: 'contexto';
      skillIds: string[];
      temResumo: boolean;
      nMensagensHistorico: number;
      tools: string[];
    }
  | {
      tipo: 'llm';
      tokensEntrada: number;
      tokensSaida: number;
      finishReason: string;
      toolCalls: string[];
    }
  | {
      tipo: 'tool';
      nome: string;
      params: Record<string, unknown>;
      resultado: unknown;
      latencyMs: number;
      erro?: string;
    }
  | {
      tipo: 'verdict';
      guardrail: string;
      hook: string;
      verdict: Verdict;
      /** #34: draft que o block/escalate descartou — insumo do correcao_hitl. */
      draftDescartado?: string;
    }
  | { tipo: 'fallback'; motivo: string }
  | { tipo: 'escalado' };

/** Efeitos do nó responder — implementados pelo server (outbox, resumo). */
export interface ResponderEfeitos {
  gravarResposta(texto: string, meta: { escalado: boolean; fallback: boolean }): Promise<void>;
  atualizarResumoSePreciso(): Promise<void>;
}

export interface LimitesTurno {
  readonly maxToolCalls: number;
  readonly timeoutMs: number;
  /** retries por tool que falhou (spec 005: 1). */
  readonly retriesPorTool: number;
}

export interface TurnoInput {
  readonly session: SessionCtx;
  readonly persona: string;
  readonly resumo: string | null;
  /** ids+conteúdo de skills top-k (009; stub [] até lá). */
  readonly skills: readonly { id: string; conteudo: string }[];
  readonly historico: readonly ChatMessage[];
  readonly textoUsuario: string;
  readonly tools: readonly ToolSpec[];
  readonly limites: LimitesTurno;
  readonly efeitos: ResponderEfeitos;
}

export interface ResultadoTurno {
  readonly resposta: string;
  readonly escalado: boolean;
  /** Gatilho da escalada (006): negociacao_preco | tema_sensivel | pedido_explicito | falhas_tool | ... */
  readonly escaladoTrigger: string | null;
  readonly fallback: boolean;
  readonly fallbackMotivo: string | null;
  readonly eventos: readonly TraceEvento[];
  readonly tokensEntrada: number;
  readonly tokensSaida: number;
  readonly latenciaMs: number;
}

export interface AgentRuntimeDeps {
  readonly provider: AIProvider;
  /** Pipeline de guardrails (006): beforeTool/afterTool/beforeReply. */
  readonly guardrails?: readonly GuardrailHooks[];
}

export interface AgentRuntime {
  processarTurno(input: TurnoInput): Promise<ResultadoTurno>;
}
