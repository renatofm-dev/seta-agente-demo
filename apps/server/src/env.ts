import { z } from 'zod';

/** Contrato de ambiente do server. Env inválida derruba o boot — nunca sobe "meio configurado". */
export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.url(),
  ERP_DATABASE_URL: z.url(),
  CLIENT_CONFIG_PATH: z.string().min(1).default('configs/demo/client.yaml'),
  /** Simulador dev: expõe POST /dev/inbound e GET /dev/events (plano B da demo). */
  DEV_SIMULATOR: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /** Verificação do webhook Meta (GET /webhook) e HMAC do POST. Defaults só para dev. */
  WA_VERIFY_TOKEN: z.string().min(1).default('dev-verify-token'),
  WA_APP_SECRET: z.string().min(1).default('dev-app-secret'),
  /** Credenciais da Cloud API. Ausentes ⇒ gateway de saída vira log-only (dev). */
  WA_ACCESS_TOKEN: z.string().optional(),
  WA_PHONE_NUMBER_ID: z.string().optional(),
  /** Silêncio (ms) que fecha um turno no debouncer. */
  WA_DEBOUNCE_MS: z.coerce.number().int().min(100).default(4_000),
});
export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Env inválida:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
