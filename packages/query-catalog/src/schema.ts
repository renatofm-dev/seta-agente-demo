import { z } from 'zod';

/**
 * Schema das entradas do catálogo (catalog/<dominio>/<nome>.yaml).
 * O catálogo é a ÚNICA via de acesso a dado estruturado: o agente escolhe
 * tool + parâmetros, nunca escreve SQL.
 */

export const CatalogEntryIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/, 'id deve ser dominio.nome (snake_case)');
export type CatalogEntryId = z.infer<typeof CatalogEntryIdSchema>;

/**
 * Origem de um parâmetro: `session` vem do contexto autenticado (ex.: cliente_id),
 * NUNCA do modelo; `agent` pode ser preenchido pelo modelo e é validado antes do bind.
 */
export const ParamSourceSchema = z.enum(['session', 'agent']);
export type ParamSource = z.infer<typeof ParamSourceSchema>;

export const ParamTypeSchema = z.enum(['string', 'int', 'date', 'boolean']);
export type ParamType = z.infer<typeof ParamTypeSchema>;

export const ParamSpecSchema = z.object({
  type: ParamTypeSchema,
  source: ParamSourceSchema,
  required: z.boolean().default(true),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  description: z.string().optional(),
});
export type ParamSpec = z.infer<typeof ParamSpecSchema>;

export const CatalogEntrySchema = z.object({
  id: CatalogEntryIdSchema,
  version: z.number().int().min(1),
  description: z.string().min(20, 'description é o que o modelo lê — capriche'),
  entities: z.array(z.string().min(1)).min(1),
  modules: z.array(z.string().min(1)).default([]),
  params: z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), ParamSpecSchema).default({}),
  sql: z.string().min(10),
  limits: z
    .object({
      timeout_ms: z.number().int().min(100).max(30_000).default(3_000),
      max_rows: z.number().int().min(1).max(1_000).default(100),
    })
    .default({ timeout_ms: 3_000, max_rows: 100 }),
  output: z.object({
    columns: z.array(z.string().min(1)).min(1),
    masking: z.record(z.string(), z.string()).default({}),
  }),
  tool: z.object({
    expose: z.boolean(),
    name: z.string().regex(/^[a-z][a-z0-9_]*$/, 'nome de tool em snake_case'),
  }),
  price_source: z.boolean().default(false),
});
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;

/** Zod de runtime para valores de param, por tipo declarado no YAML. */
export function zodDoParam(spec: ParamSpec): z.ZodType {
  switch (spec.type) {
    case 'string':
      return z.string().min(1).max(200);
    case 'int':
      return z.number().int().min(0).max(1_000_000);
    case 'date':
      return z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'data em YYYY-MM-DD');
    case 'boolean':
      return z.boolean();
  }
}
