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
/**
 * 036: credencial de exemplo do simulador do TSE. É credencial de OPERADOR, com
 * poder de escrita financeira e de venda — em produção o boot recusa.
 */
export const CREDENCIAL_TSE_DE_DEV = 'integracao';

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
  WA_TEMPLATE_COBRANCA_BOLETO: z
    .string()
    .regex(/^[a-z0-9_]+$/)
    .optional(),
  /** Reenvio de boleto já emitido — texto reconhece o envio anterior. */
  WA_TEMPLATE_BOLETO_SEGUNDA_VIA: z
    .string()
    .regex(/^[a-z0-9_]+$/)
    .optional(),
  WA_TEMPLATE_COBRANCA_CARTAO: z
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
  /**
   * 045 — venda de ponta a ponta.
   *
   * `VENDA_SINAL_CENTAVOS`: o sinal que o PIX cobra. Fixo (e não percentual)
   * porque é assim que a operação fala com o comprador — "dois mil de sinal" —
   * e porque um percentual de cota cairia num valor que ninguém paga por PIX.
   *
   * `VENDA_ID_PRODUTO`: `SetVenda` exige `IdProduto`, e o espelho do ERP não
   * modela produto (a 012 levantou as 36 tabelas e ele não está lá). 111 é o
   * `INFINITY 900` do `Lookup/Produtos` do fornecedor. QUAL produto corresponde
   * a cada tier de cota é pergunta aberta ao cliente — registrada no PR.
   *
   * `VENDA_MEIO_PAGAMENTO_*`: ids de `meiopagamento` no espelho (1 = BOLETO,
   * 2 = PIX). O sinal entra como PIX porque foi PIX; o saldo, como boleto.
   */
  VENDA_SINAL_CENTAVOS: z.coerce.number().int().min(100).default(200_000),
  VENDA_ID_PRODUTO: z.coerce.number().int().positive().default(111),
  VENDA_MEIO_PAGAMENTO_SINAL: z.coerce.number().int().positive().default(2),
  VENDA_MEIO_PAGAMENTO_SALDO: z.coerce.number().int().positive().default(1),
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
  /**
   * 036: API do TS Explorer (ADR 0002). Ausente ⇒ o `ErpWriter` simulado assume e
   * a baixa vira registro local — o boot loga qual dos dois está ativo, no mesmo
   * desenho do PSP da 014. Em dev e no homelab aponta para o simulador da 035
   * (`http://tse-sim:3010`); na 041 passa a apontar para o TSE de verdade, e é a
   * ÚNICA coisa que muda.
   */
  TSE_BASE_URL: z.url().optional(),
  /** Credencial de operador: escreve baixa, reserva e venda. Cofre e rotação. */
  TSE_USERNAME: z.string().min(1).optional(),
  TSE_PASSWORD: z.string().min(1).optional(),
  TSE_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(15_000),
  /**
   * Quanto a conciliação da 014 ainda compensa: `auto` (default) compensa só o
   * que ainda não chegou ao ERP; `on` é o comportamento anterior à 036; `off`
   * nem decora o executor. `conciliacao.ts` só é APAGADO na 041.
   */
  ERP_CONCILIACAO: z.enum(['auto', 'on', 'off']).default('auto'),
  /**
   * 038: acima desta taxa de manutenção a reserva espera aprovação humana.
   * Teto PRÓPRIO, não o de pagamento: aqui o HITL não segura dinheiro nosso,
   * segura o compromisso do cotista com uma taxa que o ERP vai faturar.
   */
  RESERVA_TETO_TAXA_SEM_HITL_CENTAVOS: z.coerce.number().int().min(0).default(100_000),
  /** Fluxo de reserva sem resposta expira (minutos). */
  RESERVA_FLUXO_EXPIRA_MIN: z.coerce.number().int().min(1).default(60),
  /**
   * Credencial de operador DEDICADA ao agente. O TSE grava quem pediu a reserva
   * (`IdOperadorRespSolicitacao`), e é isso que separa, na auditoria, o que o
   * robô fez do que um atendente fez. Ausentes ⇒ usa a credencial da 036.
   */
  TSE_RESERVA_USERNAME: z.string().min(1).optional(),
  TSE_RESERVA_PASSWORD: z.string().min(1).optional(),
  /**
   * 046: quem assina o contrato. `simulado` (default) desenha a página de
   * assinatura aqui mesmo; `autentique` fala com a API deles. A demo roda no
   * simulado por decisão da spec — o webhook do Autentique registra CPF,
   * nascimento, IP e cidade de quem assina, e uma demonstração não pode criar
   * registro de assinatura real de quem só está assistindo.
   */
  ASSINATURA_PROVIDER: z.enum(['simulado', 'autentique']).default('simulado'),
  ASSINATURA_AUTENTIQUE_TOKEN: z.string().min(1).optional(),
  /**
   * 046: a origem PÚBLICA deste servidor — a que o celular de quem assina
   * consegue abrir. Em dev é a URL do túnel, que muda a cada `pnpm
   * dev-whatsapp`; em produção é o domínio fixo. Sem ela o link de assinatura
   * sairia apontando para `localhost`, que só existe nesta máquina.
   */
  PUBLIC_BASE_URL: z.url().default('http://localhost:3001'),
});
export const EnvSchema = EnvSchemaBase.superRefine((env, ctx) => {
  // vale em qualquer ambiente: apontar para o TSE sem credencial é boot mudo
  if (env.TSE_BASE_URL && !(env.TSE_USERNAME && env.TSE_PASSWORD)) {
    ctx.addIssue({
      code: 'custom',
      path: ['TSE_USERNAME'],
      message: 'TSE_BASE_URL definido exige TSE_USERNAME e TSE_PASSWORD',
    });
  }
  if (env.ASSINATURA_PROVIDER === 'autentique' && !env.ASSINATURA_AUTENTIQUE_TOKEN) {
    ctx.addIssue({
      code: 'custom',
      path: ['ASSINATURA_AUTENTIQUE_TOKEN'],
      message: 'ASSINATURA_PROVIDER=autentique exige ASSINATURA_AUTENTIQUE_TOKEN',
    });
  }
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
  if (env.TSE_PASSWORD === CREDENCIAL_TSE_DE_DEV || env.TSE_USERNAME === CREDENCIAL_TSE_DE_DEV) {
    ctx.addIssue({
      code: 'custom',
      path: ['TSE_PASSWORD'],
      message:
        'credencial de exemplo do simulador não sobe em produção — defina TSE_USERNAME/TSE_PASSWORD no .env.prod',
    });
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

/**
 * Variável VAZIA é variável AUSENTE.
 *
 * O compose de produção escreve `''` para tudo que não foi configurado
 * (`${VAR:-}`), e `.optional()` sozinho não cobre string vazia: `min(1)` recusa
 * e o boot morre pedindo justamente o que era opcional. Foi assim que a primeira
 * subida na VPS caiu — `ASSINATURA_AUTENTIQUE_TOKEN` vazio derrubou o server que
 * não precisa dele.
 *
 * Fica aqui, e não em cada campo, porque a regra é do CONTRATO de ambiente: em
 * env não existe "string vazia configurada" — quem não define, não define.
 * Obrigatória vazia continua erro, e com mensagem melhor ("obrigatória" em vez
 * de "muito curta").
 */
function semVazias(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([, v]) => v !== ''));
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(semVazias(source));
  if (!parsed.success) {
    throw new Error(`Env inválida:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
