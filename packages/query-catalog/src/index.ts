import { z } from 'zod';

/**
 * Port QueryCatalog: única via de acesso do agente a dados do ERP.
 * Entradas YAML em catalog/ e executor chegam na spec 003.
 */

export const CatalogEntryIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, 'id de entrada deve ser kebab-case');
export type CatalogEntryId = z.infer<typeof CatalogEntryIdSchema>;

/**
 * Origem de um parâmetro: `session` vem do contexto autenticado (ex.: clienteId),
 * NUNCA do LLM; `llm` pode ser preenchido pelo modelo e é validado antes do bind.
 */
export const ParamSourceSchema = z.enum(['session', 'llm']);
export type ParamSource = z.infer<typeof ParamSourceSchema>;

export interface QueryExecutionContext {
  readonly traceId: string;
  readonly sessionParams: Readonly<Record<string, string | number | boolean>>;
}

export interface QueryCatalog {
  execute(
    entryId: CatalogEntryId,
    llmParams: Readonly<Record<string, unknown>>,
    ctx: QueryExecutionContext,
  ): Promise<readonly Record<string, unknown>[]>;
  list(): readonly CatalogEntryId[];
}
