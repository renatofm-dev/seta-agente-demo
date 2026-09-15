import { z } from 'zod';

/**
 * P-28: valores que só servem em dev. Em NODE_ENV=production o boot RECUSA
 * qualquer um deles — o servidor exposto nunca sobe com segredo de exemplo.
 */
export const DEFAULTS_DE_DEV = {
  WA_VERIFY_TOKEN: 'dev-verify-token',
  WA_APP_SECRET: 'dev-app-secret',
  BETTER_AUTH_SECRET: 'dev-secret-trocar-em-prod',
} as const;
/** Senhas do init de dev do Postgres — nunca numa URL de banco em produção. */
export const SENHAS_DE_DEV = ['app_owner_dev', 'erp_ro_dev'] as const;

/** Contrato de ambiente do server. Env inválida derruba o boot — nunca sobe "meio configurado". */
export const EnvSchemaBase = z.object({
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
  /** 013: WhatsApp Business Account id — habilita a gestão de modelos na Meta. */
  WA_WABA_ID: z.string().optional(),
  /**
   * Silêncio (ms) que fecha um turno no debouncer. #46: 10s de base — quem
   * digita a 2ª frase no celular leva 10–20s; a janela ainda se adapta à
   * última mensagem (fecho 0.6×, continuação 1.5×).
   */
  WA_DEBOUNCE_MS: z.coerce.number().int().min(100).default(10_000),
  /** Provedor LLM OpenAI-compatible. Ausente ⇒ agente responde fallback honesto. */
  LLM_BASE_URL: z.url().optional(),
  LLM_API_KEY: z.string().min(1).optional(),
  LLM_MODEL: z.string().min(1).optional(),
  EMBEDDING_MODEL: z.string().min(1).optional(),
  /** Preço por 1M de tokens (custo estimado do /metricas; unidade livre, ex.: USD). */
  LLM_PRECO_IN_POR_1M: z.coerce.number().min(0).default(0),
  LLM_PRECO_OUT_POR_1M: z.coerce.number().min(0).default(0),
  /** Dimensão dos embeddings (coluna vector é sem typmod; cast/índice usam isto). */
  EMBEDDING_DIM: z.coerce.number().int().positive().default(1536),
  /** Diretório da base de conhecimento ingerida por `pnpm kb:ingest` (008). */
  KB_DIR: z.string().min(1).default('kb'),
  /** Turnos processados em paralelo (conversas diferentes) — #28. */
  AGENT_TURNOS_CONCORRENTES: z.coerce.number().int().min(1).default(3),
  /** Timeout do turno do agente (spec 005: 60 s). */
  AGENT_TURN_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(60_000),
  /** Sumarização barata do resumo rolante a cada K turnos. */
  AGENT_RESUMO_A_CADA_TURNOS: z.coerce.number().int().min(1).default(4),
  /** Diretório das entradas do catálogo de queries. */
  CATALOG_DIR: z.string().min(1).default('catalog'),
  /** Vínculos demo wa_id→cliente (seed grava na tabela contato — 007). */
  CONTATOS_PATH: z.string().min(1).default('configs/demo/contatos.yaml'),
  /** Skills escritos à mão importados no seed (009). */
  SKILLS_SEED_DIR: z.string().min(1).default('skills-seed'),
  /** Better Auth (console HITL). Trocar o secret fora de dev. */
  BETTER_AUTH_SECRET: z.string().min(8).default('dev-secret-trocar-em-prod'),
  BETTER_AUTH_URL: z.url().default('http://localhost:3001'),
  /**
   * 014: PSP Asaas (ADR 0001). Sem ASAAS_API_KEY o boot usa o PSP simulado.
   * A base URL decide o ambiente (sandbox|producao) — o boot loga qual está ativo.
   */
  ASAAS_BASE_URL: z.url().default('https://api-sandbox.asaas.com/v3'),
  ASAAS_API_KEY: z.string().min(1).optional(),
  /** Token que o Asaas manda no header `asaas-access-token`; ausente ⇒ webhook 503. */
  ASAAS_WEBHOOK_TOKEN: z.string().min(32).max(255).optional(),
  /** Acima disto a cobrança espera aprovação humana (R$ 5.000 default). */
  PAGAMENTO_TETO_SEM_HITL_CENTAVOS: z.coerce.number().int().min(0).default(500_000),
  /** Cobranças emitidas por conversa por dia; além disso, humano. */
  PAGAMENTO_MAX_COBRANCAS_DIA: z.coerce.number().int().min(1).default(3),
  /** Vencimento da cobrança no PSP = hoje + N dias (parcela vencida precisa de boleto pagável). */
  PAGAMENTO_DIAS_VENCIMENTO: z.coerce.number().int().min(0).max(60).default(3),
  /** Fluxo de cobrança sem resposta expira (minutos). */
  PAGAMENTO_FLUXO_EXPIRA_MIN: z.coerce.number().int().min(1).default(60),
  /** Modelo aprovado (013) para avisar "pagamento confirmado" fora da janela de 24h. */
  /**
   * 043: modelo aprovado com botão `order_details` para mandar a cobrança fora
   * da janela de 24h. Ausente ⇒ janela fechada segue o comportamento da 014
   * (outbox marca `janela_fechada` e escala ticket).
   */
  WA_TEMPLATE_COBRANCA_PIX: z
    .string()
    .regex(/^[a-z0-9_]+$/)
    .optional(),
  WA_TEMPLATE_PAGAMENTO_CONFIRMADO: z
    .string()
    .regex(/^[a-z0-9_]+$/)
    .optional(),
  /**
   * 015: agente SDR para lead frio. Alçada em basis points (300 = 3%) sobre o
   * valor de tabela da cota — política nossa, o ERP só conhece o preço cheio.
   */
  SDR_DESCONTO_MAX_BPS: z.coerce.number().int().min(0).max(10_000).default(300),
  SDR_FLUXO_EXPIRA_MIN: z.coerce.number().int().min(1).default(60),
  SDR_MAX_PROPOSTAS_DIA: z.coerce.number().int().min(1).default(3),
  /**
   * 016: anonimização do que sai para a LLM (decorator do AIProvider). Ligada por
   * default — desligar é decisão explícita. NER local via @huggingface/transformers;
   * sem o modelo no cache, o boot segue só com regex + dicionário e loga.
   */
  LLM_ANONIMIZAR: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  ANONIMIZACAO_NER: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  ANONIMIZACAO_NER_MODELO: z
    .string()
    .min(1)
    .default('Xenova/distilbert-base-multilingual-cased-ner-hrl'),
  /** Cache dos modelos (a imagem de produção já traz o modelo aqui). */
  ANONIMIZACAO_MODELOS_DIR: z.string().min(1).default('.modelos'),
  /** Permite baixar do Hugging Face se o modelo não estiver no cache. */
  ANONIMIZACAO_NER_DOWNLOAD: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});
export const EnvSchema = EnvSchemaBase.superRefine((env, ctx) => {
  if (env.NODE_ENV !== 'production') return;
  for (const [chave, valorDev] of Object.entries(DEFAULTS_DE_DEV)) {
    if (env[chave as keyof typeof DEFAULTS_DE_DEV] === valorDev) {
      ctx.addIssue({
        code: 'custom',
        path: [chave],
        message: `valor de desenvolvimento não é aceito em produção — defina ${chave} no .env.prod`,
      });
    }
  }
  for (const chave of ['DATABASE_URL', 'ERP_DATABASE_URL'] as const) {
    if (SENHAS_DE_DEV.some((s) => env[chave].includes(s))) {
      ctx.addIssue({
        code: 'custom',
        path: [chave],
        message: `senha de desenvolvimento na URL do banco em produção — defina ${chave} com a senha real`,
      });
    }
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
