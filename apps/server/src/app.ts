import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AIProvider } from '@seta/ai-provider';
import type { ClientConfig } from '@seta/client-config';
import { createLogger, newTraceId, type ObsEmitter } from '@seta/observability';
import type { PaymentProvider } from '@seta/payment-provider';
import type { Executor } from '@seta/query-catalog';
import type { SkillRegistry } from '@seta/skills';
import type { TemplateApi } from '@seta/wa-meta';
import { type FastifyInstance, fastify, LogController, type RawServerDefault } from 'fastify';
import type { PgBoss } from 'pg-boss';
import type { Logger } from 'pino';
import { aprendizadoRoutes } from './aprendizado-routes.js';
import { type AssinaturaRoutesOpts, assinaturaRoutes } from './assinatura/routes.js';
import type { Auth } from './auth.js';
import { authRoutes } from './auth-routes.js';
import { consoleRoutes } from './console-routes.js';
import type { Db } from './db/index.js';
import { disparosRoutes } from './disparos-routes.js';
import type { Env } from './env.js';
import { cobrancasRoutes } from './pagamentos/cobrancas-routes.js';
import { eventosPspRoutes } from './pagamentos/eventos-routes.js';
import type { PagamentosRepo } from './pagamentos/repo.js';
import { webhookPspRoutes } from './pagamentos/webhook-routes.js';
import { relatoriosRoutes } from './relatorios-routes.js';
import { reservasRoutes } from './reserva/reservas-routes.js';
import type { SdrFluxoDeps } from './sdr/fluxo.js';
import { leadsRoutes } from './sdr/leads-routes.js';
import { vendasRoutes } from './venda/vendas-routes.js';
import { devRoutes } from './wa/dev-routes.js';
import { waRoutes } from './wa/routes.js';

export type App = FastifyInstance<
  RawServerDefault,
  IncomingMessage,
  ServerResponse<IncomingMessage>,
  Logger
>;

export interface WaDeps {
  readonly db: Db;
  readonly boss: PgBoss;
}

export interface ConsoleDeps {
  readonly auth: Auth;
  readonly executor: Executor;
  /** Aba Aprendizado (009); ausentes ⇒ rotas não registradas. */
  readonly registry?: SkillRegistry;
  readonly provider?: AIProvider | null;
  /** #30: contabiliza tokens do distiller no evento_llm. */
  readonly obs?: ObsEmitter;
  /** 013: gestão de modelos na Meta; null ⇒ rotas respondem 503 explicado. */
  readonly templateApi?: TemplateApi | null;
}

/** 014: webhook do PSP (com `wa`) e console de cobranças (com `console`). */
export interface PagamentosDeps {
  readonly repo: PagamentosRepo;
  readonly psp: PaymentProvider;
}

export interface BuildAppOptions {
  readonly env: Env;
  readonly clientConfig: ClientConfig;
  /** Sem deps de WA (ex.: teste de healthz) as rotas do canal não são registradas. */
  readonly wa?: WaDeps;
  /** Sem deps do console, as rotas /api/* não são registradas. */
  readonly console?: ConsoleDeps;
  /** Sem deps de pagamentos, nem webhook nem /api/console/cobrancas existem. */
  readonly pagamentos?: PagamentosDeps;
  /**
   * 015b: sem isto, `/api/console/leads` continua só leitura — aprovar,
   * recusar e contrapropor não são registrados. É o degrau que mantém a 015a
   * funcionando sozinha.
   */
  readonly sdr?: SdrFluxoDeps;
  /**
   * 046: assinatura do contrato. Ausente ⇒ nem a página nem o webhook existem,
   * e a venda termina onde terminava antes — no contrato registrado.
   */
  readonly assinatura?: Omit<AssinaturaRoutesOpts, 'cliente'>;
}

export function buildApp({
  env,
  clientConfig,
  wa,
  console: consoleDeps,
  pagamentos,
  sdr,
  assinatura,
}: BuildAppOptions): App {
  const app = fastify({
    loggerInstance: createLogger({ name: 'server', level: env.LOG_LEVEL }),
    genReqId: () => newTraceId(),
    logController: new LogController({ requestIdLogLabel: 'traceId' }),
  });

  app.get('/healthz', async () => ({
    status: 'ok',
    cliente: clientConfig.nome,
    uptimeSegundos: Math.round(process.uptime()),
  }));
  // tela de login: nome da instalação (o mesmo dado público do /healthz)
  app.get('/api/instalacao', async () => ({ nome: clientConfig.nome }));

  if (wa) {
    app.register(waRoutes, { env, db: wa.db, boss: wa.boss });
    if (pagamentos) app.register(webhookPspRoutes, { env, db: wa.db, boss: wa.boss });
    // 046: página de assinatura e webhook do provedor — públicas, sem sessão
    if (assinatura) app.register(assinaturaRoutes, { ...assinatura, cliente: clientConfig.nome });
    if (env.DEV_SIMULATOR) {
      // com console (auth) presente, o simulador exige sessão — plano B da
      // demo fica atrás de login quando exposto em produção (011)
      app.register(devRoutes, { env, db: wa.db, boss: wa.boss, auth: consoleDeps?.auth });
    }
    if (consoleDeps) {
      app.register(authRoutes, { auth: consoleDeps.auth });
      app.register(consoleRoutes, {
        db: wa.db,
        boss: wa.boss,
        auth: consoleDeps.auth,
        executor: consoleDeps.executor,
        debounceMs: env.WA_DEBOUNCE_MS,
        limiteResposta: clientConfig.limites.maxCaracteresResposta,
        precos: { inPor1M: env.LLM_PRECO_IN_POR_1M, outPor1M: env.LLM_PRECO_OUT_POR_1M },
        instalacao: {
          nome: clientConfig.nome,
          modulos: clientConfig.modulos,
          limites: clientConfig.limites,
          guardrails: clientConfig.guardrails,
          alcadas: {
            tetoAprovacaoCentavos: env.PAGAMENTO_TETO_SEM_HITL_CENTAVOS,
            maxCobrancasDia: env.PAGAMENTO_MAX_COBRANCAS_DIA,
            diasVencimento: env.PAGAMENTO_DIAS_VENCIMENTO,
            descontoMaxBps: env.SDR_DESCONTO_MAX_BPS,
            maxPropostasDia: env.SDR_MAX_PROPOSTAS_DIA,
            // 038: teto PRÓPRIO — aqui o HITL não segura dinheiro nosso, segura
            // o compromisso do cotista com uma taxa que o ERP vai faturar
            tetoTaxaReservaCentavos: env.RESERVA_TETO_TAXA_SEM_HITL_CENTAVOS,
          },
          canal: {
            gateway: env.WA_ACCESS_TOKEN ? 'meta' : 'log-only',
            metaConfigurada: Boolean(consoleDeps.templateApi),
            simulador: env.DEV_SIMULATOR,
          },
          psp: pagamentos ? { nome: pagamentos.psp.nome, ambiente: pagamentos.psp.ambiente } : null,
          campanhas: { metaConversaoBps: clientConfig.campanhas.metaConversaoBps },
        },
      });
      // Leads (015): leitura das tabelas do SDR; ações ficam com a 015b
      app.register(leadsRoutes, { db: wa.db, auth: consoleDeps.auth, sdr }); // 015b
      app.register(disparosRoutes, {
        db: wa.db,
        boss: wa.boss,
        auth: consoleDeps.auth,
        templateApi: consoleDeps.templateApi ?? null,
      });
      // Relatórios (017): campanhas × resultado × meta de conversão
      app.register(relatoriosRoutes, {
        db: wa.db,
        auth: consoleDeps.auth,
        metaConversaoBps: clientConfig.campanhas.metaConversaoBps,
      });
      if (pagamentos) {
        app.register(cobrancasRoutes, {
          env,
          db: wa.db,
          boss: wa.boss,
          auth: consoleDeps.auth,
          repo: pagamentos.repo,
          psp: pagamentos.psp,
        });
        app.register(eventosPspRoutes, {
          db: wa.db,
          boss: wa.boss,
          auth: consoleDeps.auth,
        });
      }
      // Reservas (038): listagem e a aprovação da taxa de manutenção
      if (clientConfig.modulos.reserva) {
        app.register(reservasRoutes, { db: wa.db, boss: wa.boss, auth: consoleDeps.auth });
        // 046: com as deps de assinatura, a tela ganha o reenvio do link
        app.register(vendasRoutes, {
          db: wa.db,
          auth: consoleDeps.auth,
          ...(assinatura ? { assinatura } : {}),
        }); // 045
      }
      if (consoleDeps.registry) {
        app.register(aprendizadoRoutes, {
          db: wa.db,
          auth: consoleDeps.auth,
          registry: consoleDeps.registry,
          provider: consoleDeps.provider ?? null,
          obs: consoleDeps.obs,
        });
      }
    }
  }

  return app;
}
