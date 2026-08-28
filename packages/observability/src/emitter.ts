import { z } from 'zod';

/**
 * Emissor tipado de eventos de observabilidade (010). Métodos SÍNCRONOS e
 * fire-and-forget: a implementação grava em background e NUNCA lança — falha
 * de observabilidade não pode derrubar o turno (critério da spec).
 * `evento_query` (003) já é emitido pelo executor do catálogo.
 */

const Base = z.object({
  traceId: z.string().min(1),
  conversaId: z.uuid(),
  turnoId: z.uuid().nullable().default(null),
  ticketId: z.uuid().nullable().default(null),
});

export const EventoLlmSchema = Base.extend({
  modelo: z.string().min(1),
  tokensEntrada: z.number().int().min(0),
  tokensSaida: z.number().int().min(0),
  latenciaMs: z.number().int().min(0),
});
export type EventoLlm = z.infer<typeof EventoLlmSchema>;

export const EventoGuardrailSchema = Base.extend({
  guardrail: z.string().min(1), // ex.: preco, classificador_intencao
  hook: z.enum(['beforeTool', 'afterTool', 'beforeReply']),
  verdict: z.enum(['allow', 'rewrite', 'block', 'escalate']),
  motivo: z.string().nullable().default(null),
});
export type EventoGuardrail = z.infer<typeof EventoGuardrailSchema>;

export const EventoEscalonamentoSchema = Base.extend({
  motivo: z.string().min(1), // trigger: negociacao_preco, tema_sensivel, ...
  origem: z.enum(['guardrail', 'intencao', 'agente', 'falha_tool', 'erro']),
});
export type EventoEscalonamento = z.infer<typeof EventoEscalonamentoSchema>;

export interface ObsEmitter {
  llm(evento: EventoLlm): void;
  guardrail(evento: EventoGuardrail): void;
  escalonamento(evento: EventoEscalonamento): void;
}

/** Emissor nulo: turnos rodam sem observabilidade (testes/ferramentas). */
export function createNoopObsEmitter(): ObsEmitter {
  return { llm() {}, guardrail() {}, escalonamento() {} };
}
