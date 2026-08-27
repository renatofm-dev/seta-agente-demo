import type { DbConnector, Scalar } from '@seta/erp-connector';
import { z } from 'zod';
import type { CatalogIndex } from './loader.js';
import { applyMasking } from './masking.js';
import { zodDoParam } from './schema.js';

/**
 * Executor do catálogo: resolve params (session NUNCA vem do modelo), aplica
 * limits da entrada, chama o DbConnector, mascara colunas e grava evento_query.
 */

export interface SessionCtx {
  readonly traceId: string;
  /** Cliente do ERP vinculado ao contato. Sem vínculo ⇒ sem acesso a dado. */
  readonly clienteId: string;
}

export interface QueryEvent {
  readonly traceId: string;
  readonly entryId: string;
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly linhas: number;
  readonly truncated: boolean;
  readonly erro?: string;
}

export interface QueryEventSink {
  record(evento: QueryEvent): Promise<void>;
}

export interface CatalogLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface RunResult {
  readonly rows: readonly Record<string, unknown>[];
  readonly rowCount: number;
  readonly truncated: boolean;
}

export interface Executor {
  run(id: string, rawParams: Record<string, unknown>, session: SessionCtx): Promise<RunResult>;
}

export interface CreateExecutorOptions {
  readonly catalog: CatalogIndex;
  readonly connector: DbConnector;
  readonly sink: QueryEventSink;
  readonly logger?: CatalogLogger;
}

const LOGGER_NULO: CatalogLogger = { info: () => {}, warn: () => {} };

/** Valores de sessão disponíveis para params `source: session`, por nome. */
function valoresDeSessao(session: SessionCtx): Record<string, Scalar> {
  return { cliente_id: session.clienteId };
}

export function createExecutor(opts: CreateExecutorOptions): Executor {
  const { catalog, connector, sink } = opts;
  const logger = opts.logger ?? LOGGER_NULO;

  return {
    async run(id, rawParams, session) {
      const entry = catalog.get(id);
      const sessao = valoresDeSessao(session);
      const binds: Record<string, Scalar> = {};

      for (const [nome, spec] of Object.entries(entry.params)) {
        if (spec.source === 'session') {
          // valor vindo do modelo para param de sessão é IGNORADO e logado
          if (nome in rawParams) {
            logger.warn(
              { traceId: session.traceId, entryId: id, param: nome },
              'param de sessão recebido do agente — ignorado (usando valor da sessão)',
            );
          }
          const valor = sessao[nome];
          if (valor === undefined) {
            throw new Error(`sessão não fornece o param "${nome}" exigido por ${id}`);
          }
          binds[nome] = valor;
          continue;
        }

        const bruto = rawParams[nome] ?? spec.default;
        if (bruto === undefined) {
          if (spec.required) throw new Error(`param obrigatório ausente: "${nome}" em ${id}`);
          continue; // opcional sem default e sem valor: SQL não deve referenciar? validador exige bind⇔param, então default é obrigatório na prática
        }
        const parseado = zodDoParam(spec).safeParse(bruto);
        if (!parseado.success) {
          throw new Error(`param "${nome}" inválido em ${id}: ${z.prettifyError(parseado.error)}`);
        }
        binds[nome] = parseado.data as Scalar;
      }

      const inicio = performance.now();
      try {
        const resultado = await connector.execute(
          { sql: entry.sql, binds },
          { timeoutMs: entry.limits.timeout_ms, maxRows: entry.limits.max_rows },
        );
        const rows = applyMasking(resultado.rows, entry.output.masking);
        await gravar(sink, logger, {
          traceId: session.traceId,
          entryId: id,
          ok: true,
          latencyMs: resultado.latencyMs,
          linhas: resultado.rowCount,
          truncated: resultado.truncated,
        });
        return { rows, rowCount: resultado.rowCount, truncated: resultado.truncated };
      } catch (err) {
        await gravar(sink, logger, {
          traceId: session.traceId,
          entryId: id,
          ok: false,
          latencyMs: Math.round(performance.now() - inicio),
          linhas: 0,
          truncated: false,
          erro: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    },
  };
}

async function gravar(sink: QueryEventSink, logger: CatalogLogger, evento: QueryEvent) {
  try {
    await sink.record(evento);
  } catch (err) {
    // auditoria nunca derruba a resposta ao contato
    logger.warn(
      { traceId: evento.traceId, entryId: evento.entryId, erro: String(err) },
      'falha ao gravar evento_query',
    );
  }
}
