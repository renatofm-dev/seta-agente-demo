import { z } from 'zod';

/** Contrato de ambiente do server. Env inválida derruba o boot — nunca sobe "meio configurado". */
export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.url(),
  ERP_DATABASE_URL: z.url(),
  CLIENT_CONFIG_PATH: z.string().min(1).default('configs/demo/client.yaml'),
});
export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Env inválida:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
