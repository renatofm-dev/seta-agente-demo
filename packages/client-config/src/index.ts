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
    contrato: z.boolean(),
    atendimento: z.boolean(),
    /** 014: fluxo de cobrança/pagamento pelo WhatsApp (exige `financeiro`). */
    pagamentos: z.boolean().default(false),
    /** 015: agente SDR na raia SEM vínculo (lead frio) + tools `comercial.*`. */
    sdr: z.boolean().default(false),
  }),
  /** 015: persona da raia do lead frio; ausente ⇒ usa `persona`. */
  personaSdr: z.string().min(1).optional(),
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
  /**
   * 017: meta de conversão das campanhas (pagas ÷ entregues), em bps. Vale
   * para toda campanha sem meta própria; o wizard pode sobrescrever.
   */
  campanhas: z
    .object({
      metaConversaoBps: z.number().int().min(0).max(10_000).default(3000),
    })
    .default({ metaConversaoBps: 3000 }),
});
export type ClientConfig = z.infer<typeof ClientConfigSchema>;

/** Lê e valida o YAML da implantação. Lança ZodError/YAMLParseError em config inválida. */
export function loadClientConfig(path: string): ClientConfig {
  const raw = readFileSync(path, 'utf-8');
  return ClientConfigSchema.parse(parse(raw));
}
