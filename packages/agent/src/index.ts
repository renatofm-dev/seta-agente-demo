import { z } from 'zod';

/**
 * Esqueleto do runtime do agente. O grafo LangGraph.js chega na spec 005.
 * Regra de fronteira: este package NUNCA importa erp-connector — dado só via query-catalog.
 */

export const AgentTurnInputSchema = z.object({
  traceId: z.uuid(),
  contatoId: z.string().min(1),
  texto: z.string().min(1).max(4096),
});
export type AgentTurnInput = z.infer<typeof AgentTurnInputSchema>;

export interface AgentTurnResult {
  readonly resposta: string;
  readonly escalado: boolean;
}

export interface AgentRuntime {
  processarTurno(input: AgentTurnInput): Promise<AgentTurnResult>;
}
