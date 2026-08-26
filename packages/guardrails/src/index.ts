import { z } from 'zod';

/**
 * Esqueleto de guardrails. Regras (ex.: não negociar desconto → escalar) chegam na spec 006.
 */

export const VerdictSchema = z.object({
  decisao: z.enum(['permitir', 'escalar', 'bloquear']),
  motivo: z.string().min(1),
});
export type Verdict = z.infer<typeof VerdictSchema>;

export interface GuardrailInput {
  readonly traceId: string;
  readonly texto: string;
  readonly direcao: 'entrada' | 'saida';
}

export interface Guardrail {
  readonly nome: string;
  avaliar(input: GuardrailInput): Promise<Verdict>;
}
