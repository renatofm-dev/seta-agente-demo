import { z } from 'zod';

/**
 * Contrato de ambiente do simulador do TSE (035). Env inválida derruba o boot —
 * um dublê "meio configurado" mente sobre o fornecedor, que é o pior defeito
 * possível aqui.
 */

/** Senha do papel criado por `infra/erp-mock/04-sim-role.sql` sem TSE_SIM_DB_PASSWORD. */
export const SENHA_DE_DEV = 'tse_sim_dev';
/** Credencial de exemplo do /token — vale em dev, nunca em produção. */
export const USERS_DE_DEV = 'integracao:integracao:1';

export const EnvSchemaBase = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TSE_SIM_PORT: z.coerce.number().int().min(1).max(65_535).default(3010),
  /** Papel `tse_sim`: escreve nas tabelas físicas, cego para as views canônicas. */
  TSE_SIM_DATABASE_URL: z
    .url()
    .default(`postgres://tse_sim:${SENHA_DE_DEV}@localhost:5432/erp_mock`),
  /** Credenciais do /token: `login:senha:idPessoa`, separadas por vírgula. */
  TSE_SIM_USERS: z.string().min(1).default(USERS_DE_DEV),
  /**
   * D10, o risco nº 1 da frente: no exemplo salvo do fornecedor o token é de
   * `TSE.INTEGRACAO` e `MeusContratos` devolve o contrato DESSE usuário — o
   * painel pode resolver escopo pelo dono do token, e o agente atende N cotistas
   * com UMA credencial. Enquanto o fornecedor não responde, o simulador exercita
   * os dois comportamentos:
   *   `qualquer` — qualquer idContrato é servido (é o que faz a demo funcionar);
   *   `token`    — só os contratos do titular dono do token (o cenário ruim).
   */
  TSE_SIM_PAINEL_ESCOPO: z.enum(['qualquer', 'token']).default('qualquer'),
  /** Caos controlado: atraso fixo por resposta e falhas 500 em basis points. */
  TSE_SIM_LATENCIA_MS: z.coerce.number().int().min(0).max(30_000).default(0),
  TSE_SIM_FALHA_BPS: z.coerce.number().int().min(0).max(10_000).default(0),
});

export const EnvSchema = EnvSchemaBase.superRefine((env, ctx) => {
  if (env.NODE_ENV !== 'production') return;
  if (env.TSE_SIM_DATABASE_URL.includes(SENHA_DE_DEV)) {
    ctx.addIssue({
      code: 'custom',
      path: ['TSE_SIM_DATABASE_URL'],
      message: 'senha de desenvolvimento na URL do banco — defina TSE_SIM_DB_PASSWORD no .env.prod',
    });
  }
  if (env.TSE_SIM_USERS === USERS_DE_DEV) {
    ctx.addIssue({
      code: 'custom',
      path: ['TSE_SIM_USERS'],
      message: 'credencial de exemplo não sobe em produção — defina TSE_SIM_USERS no .env.prod',
    });
  }
});
export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Env inválida:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
