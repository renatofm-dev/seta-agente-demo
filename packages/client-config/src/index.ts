import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';

/**
 * Schema da config de implantação (1 cliente na POC: configs/demo/client.yaml).
 * Carregada e validada no boot do server — config inválida derruba o boot.
 */

export const ClientConfigSchema = z.object({
  nome: z.string().min(1),
  persona: z.string().min(1),
  modulos: z.object({
    financeiro: z.boolean(),
    pedidos: z.boolean(),
    suporte: z.boolean(),
  }),
  limites: z.object({
    maxToolCallsPorTurno: z.number().int().min(1).max(20),
    maxMensagensContexto: z.number().int().min(1).max(200),
    maxCaracteresResposta: z.number().int().min(100).max(4096),
  }),
  /** Políticas por config (006): mecanismo genérico, lista por cliente. */
  guardrails: z
    .object({
      temasSensiveis: z.array(z.string().min(1)).default([]),
    })
    .default({ temasSensiveis: [] }),
});
export type ClientConfig = z.infer<typeof ClientConfigSchema>;

/** Lê e valida o YAML da implantação. Lança ZodError/YAMLParseError em config inválida. */
export function loadClientConfig(path: string): ClientConfig {
  const raw = readFileSync(path, 'utf-8');
  return ClientConfigSchema.parse(parse(raw));
}
