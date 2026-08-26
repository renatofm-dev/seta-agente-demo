import { z } from 'zod';

/**
 * Port DbConnector: acesso somente-leitura ao ERP via SQL com binds NOMEADOS.
 * Implementação pg chega na spec 002 — quem consome o port nunca vê a implementação.
 */

/** Valores permitidos em binds. SQL com interpolação de valores é proibido em qualquer camada. */
export const NamedBindsSchema = z.record(
  z.string().regex(/^[a-z][a-zA-Z0-9_]*$/, 'nome de bind inválido'),
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
);
export type NamedBinds = z.infer<typeof NamedBindsSchema>;

export const ConnectorConfigSchema = z.object({
  url: z.url(),
  poolMax: z.number().int().min(1).max(20).default(5),
  statementTimeoutMs: z.number().int().min(100).default(5_000),
});
export type ConnectorConfig = z.infer<typeof ConnectorConfigSchema>;

export interface DbConnector {
  /** Executa SQL parametrizado com binds nomeados (`:nome`). Somente leitura. */
  query<T>(sql: string, binds: NamedBinds): Promise<readonly T[]>;
  healthy(): Promise<boolean>;
  close(): Promise<void>;
}
