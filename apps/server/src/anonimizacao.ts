import type { AIProvider } from '@seta/ai-provider';
import {
  createAnonimizador,
  createAnonymizingProvider,
  createDicionarioDetector,
  createNerDetector,
  createRegexDetector,
  type Detector,
  type EventoAnonimizacao,
} from '@seta/anonimizacao';
import type { Logger } from 'pino';
import type { Db } from './db/index.js';
import { contato } from './db/schema.js';
import type { Env } from './env.js';

/**
 * 016: monta o decorator de anonimização do AIProvider com os três detectores
 * (regex, dicionário lendo contato.nome, NER local) e o acumulador por traceId
 * que o turno-handler drena para o trace — contagens, nunca valores.
 */

export interface EventoTraceAnonimizacao {
  tipo: 'anonimizacao';
  chamadas: number;
  substituicoes: Record<string, number>;
  tokensDesconhecidos: number;
  latenciaMs: number;
}

export interface AcumuladorAnonimizacao {
  sink(ev: EventoAnonimizacao): void;
  /** Devolve e limpa o acumulado do turno; null se nada foi chamado com esse traceId. */
  consumir(traceId: string): EventoTraceAnonimizacao | null;
}

const MAX_TRACES_PENDENTES = 10_000;

export function createAcumuladorAnonimizacao(): AcumuladorAnonimizacao {
  const porTrace = new Map<string, EventoTraceAnonimizacao>();
  return {
    sink(ev) {
      if (!ev.traceId) return; // embed e chamadas fora de turno: só o log
      const atual = porTrace.get(ev.traceId) ?? {
        tipo: 'anonimizacao' as const,
        chamadas: 0,
        substituicoes: {},
        tokensDesconhecidos: 0,
        latenciaMs: 0,
      };
      atual.chamadas += 1;
      atual.latenciaMs += ev.latenciaMs;
      atual.tokensDesconhecidos += ev.tokensDesconhecidos;
      for (const [tipo, n] of Object.entries(ev.substituicoes)) {
        atual.substituicoes[tipo] = (atual.substituicoes[tipo] ?? 0) + (n ?? 0);
      }
      porTrace.set(ev.traceId, atual);
      // higiene: trace que nunca for consumido não cresce o mapa sem limite
      if (porTrace.size > MAX_TRACES_PENDENTES) {
        const primeira = porTrace.keys().next().value;
        if (primeira !== undefined) porTrace.delete(primeira);
      }
    },
    consumir(traceId) {
      const ev = porTrace.get(traceId) ?? null;
      porTrace.delete(traceId);
      return ev;
    },
  };
}

/** Nomes do banco (contato.nome) com TTL — o dicionário lê a cada chamada. */
export function nomesDoBanco(db: Db, ttlMs = 60_000): () => Promise<readonly string[]> {
  let cache: readonly string[] = [];
  let validoAte = 0;
  let carregando: Promise<void> | null = null;
  return async () => {
    if (Date.now() < validoAte) return cache;
    if (!carregando) {
      carregando = db
        .select({ nome: contato.nome })
        .from(contato)
        .then((rows) => {
          cache = rows
            .map((r) => r.nome)
            .filter((n): n is string => typeof n === 'string' && n.length > 0);
          validoAte = Date.now() + ttlMs;
        })
        .finally(() => {
          carregando = null;
        });
    }
    await carregando;
    return cache;
  };
}

export interface MontarAnonimizacaoDeps {
  readonly env: Env;
  readonly db: Db;
  readonly logger: Logger;
  readonly provider: AIProvider;
}

export interface ProviderAnonimizado {
  readonly provider: AIProvider;
  readonly acumulador: AcumuladorAnonimizacao;
  /** Nomes dos detectores ativos — vai para o log de boot. */
  readonly detectores: readonly string[];
}

export async function montarProviderAnonimizado(
  deps: MontarAnonimizacaoDeps,
): Promise<ProviderAnonimizado> {
  const { env, db, logger } = deps;
  const detectores: Detector[] = [
    createRegexDetector(),
    createDicionarioDetector({ nomes: nomesDoBanco(db) }),
  ];
  if (env.ANONIMIZACAO_NER) {
    const ner = createNerDetector({
      modelo: env.ANONIMIZACAO_NER_MODELO,
      cacheDir: env.ANONIMIZACAO_MODELOS_DIR,
      permitirDownload: env.ANONIMIZACAO_NER_DOWNLOAD,
      onErro: (err) =>
        logger.warn({ err }, 'NER falhou nesta chamada — seguindo com regex + dicionário'),
    });
    try {
      logger.info(
        { modelo: env.ANONIMIZACAO_NER_MODELO, cache: env.ANONIMIZACAO_MODELOS_DIR },
        'carregando modelo NER (primeira vez baixa ~135 MB)',
      );
      await ner.pronto();
      detectores.push(ner);
    } catch (err) {
      // falha de carga NÃO derruba o boot: perde recall em nomes, não disponibilidade
      logger.error(
        { err, modelo: env.ANONIMIZACAO_NER_MODELO },
        'modelo NER indisponível — anonimização segue sem NER',
      );
    }
  }
  const acumulador = createAcumuladorAnonimizacao();
  const anonimizador = createAnonimizador({ detectores });
  const provider = createAnonymizingProvider(deps.provider, {
    anonimizador,
    sink: (ev) => {
      logger.debug(ev, 'anonimizacao');
      acumulador.sink(ev);
    },
  });
  return { provider, acumulador, detectores: anonimizador.detectores };
}
