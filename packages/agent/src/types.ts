import type { AIProvider, ChatMessage } from '@seta/ai-provider';
import type { Verdict } from '@seta/guardrails';
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
  | { tipo: 'verdict'; guardrail: string; decisao: Verdict['decisao']; motivo: string }
  | { tipo: 'fallback'; motivo: string }
  | { tipo: 'escalado' };

/** Hook de guardrail de saída (a 006 traz as regras; aqui só o contrato). */
export interface GuardrailSaida {
  readonly nome: string;
  avaliar(draft: string, ctx: { traceId: string }): Promise<Verdict>;
}

/** Efeitos do nó responder — implementados pelo server (outbox, resumo). */
export interface ResponderEfeitos {
  gravarResposta(texto: string, meta: { escalado: boolean; fallback: boolean }): Promise<void>;
  atualizarResumoSePreciso(): Promise<void>;
}

export interface LimitesTurno {
  readonly maxToolCalls: number;
  readonly timeoutMs: number;
  /** retries por tool que falhou (spec: 1). */
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
  readonly fallback: boolean;
  readonly fallbackMotivo: string | null;
  readonly eventos: readonly TraceEvento[];
  readonly tokensEntrada: number;
  readonly tokensSaida: number;
  readonly latenciaMs: number;
}

export interface AgentRuntimeDeps {
  readonly provider: AIProvider;
  readonly guardrails?: readonly GuardrailSaida[];
}

export interface AgentRuntime {
  processarTurno(input: TurnoInput): Promise<ResultadoTurno>;
}
