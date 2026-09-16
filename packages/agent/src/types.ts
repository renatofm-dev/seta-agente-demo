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
  | { tipo: 'escalado' }
  /** #46: turno superado — resposta descartada; o próximo turno agrega tudo. */
  | { tipo: 'descartado'; motivo: string }
  /** 014: passo do fluxo de cobrança que atendeu (ou iniciou) o turno. */
  | { tipo: 'cobranca'; etapa: string; acao: string; cobrancaId?: string }
  /** 015: passo do fluxo SDR (lead frio) que atendeu o turno. */
  | { tipo: 'sdr'; etapa: string; acao: string; propostaId?: string }
  /** 016: o que foi anonimizado antes de sair para a LLM — contagens, nunca valores. */
  | {
      tipo: 'anonimizacao';
      chamadas: number;
      substituicoes: Record<string, number>;
      tokensDesconhecidos: number;
      latenciaMs: number;
    };

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
  /** ids+conteúdo das skills ativas top-k (009) — [] quando não há registry. */
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
  /** 014: o agente chamou `iniciar_pagamento` — o server inicia o fluxo após a resposta. */
  readonly fluxoPagamentoSolicitado?: boolean;
  /** 038: o agente pediu para iniciar a reserva. */
  readonly fluxoReservaSolicitado?: boolean;
}

export interface AgentRuntimeDeps {
  readonly provider: AIProvider;
  /** Pipeline de guardrails (006): beforeTool/afterTool/beforeReply. */
  readonly guardrails?: readonly GuardrailHooks[];
}

export interface AgentRuntime {
  processarTurno(input: TurnoInput): Promise<ResultadoTurno>;
}
