import { z } from 'zod';

/**
 * Port DbConnector: acesso somente-leitura ao ERP via SQL com binds NOMEADOS.
 * Quem consome o port (query-catalog) nunca vê a implementação.
 */

/** Valores permitidos em binds. SQL com interpolação de valores é proibido em qualquer camada. */
export const NamedBindsSchema = z.record(
  z.string().regex(/^[a-z][a-zA-Z0-9_]*$/, 'nome de bind inválido'),
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
);
export type NamedBinds = z.infer<typeof NamedBindsSchema>;
export type Scalar = string | number | boolean | null;

export const ConnectorConfigSchema = z.object({
  url: z.url(),
  poolMax: z.number().int().min(1).max(20).default(5),
  statementTimeoutMs: z.number().int().min(100).default(5_000),
  defaultMaxRows: z.number().int().min(1).max(10_000).default(500),
});
export type ConnectorConfig = z.infer<typeof ConnectorConfigSchema>;
export type ConnectorConfigInput = z.input<typeof ConnectorConfigSchema>;

export const ExecOptionsSchema = z.object({
  timeoutMs: z.number().int().min(1).optional(),
  maxRows: z.number().int().min(1).max(10_000).optional(),
});
export type ExecOptions = z.infer<typeof ExecOptionsSchema>;

export interface QueryResult {
  readonly rows: readonly Record<string, unknown>[];
  readonly rowCount: number;
  /** true quando o resultado foi cortado em maxRows (havia mais linhas). */
  readonly truncated: boolean;
  readonly latencyMs: number;
}

export interface DbConnector {
  readonly dialect: 'postgres';
  execute(q: { sql: string; binds: Record<string, Scalar> }, o: ExecOptions): Promise<QueryResult>;
  health(): Promise<{ ok: boolean; latencyMs: number }>;
  close(): Promise<void>;
}

/** Erro de query cancelada por statement_timeout (código Postgres 57014). */
export class QueryTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`query excedeu o timeout de ${timeoutMs}ms`);
    this.name = 'QueryTimeoutError';
  }
}

export { bindTokens, type PositionalQuery, toPositional } from './named-binds.js';
export { createPgConnector } from './pg-connector.js';
