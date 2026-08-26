import pg from 'pg';
import {
  type ConnectorConfigInput,
  ConnectorConfigSchema,
  type DbConnector,
  type ExecOptions,
  ExecOptionsSchema,
  NamedBindsSchema,
  type QueryResult,
  QueryTimeoutError,
  type Scalar,
} from './index.js';
import { toPositional } from './named-binds.js';

/**
 * Implementação pg do DbConnector: pool dedicado (user erp_ro), transação READ ONLY,
 * statement_timeout por execução via set_config (SET não aceita bind) e corte
 * server-side em maxRows+1 via subquery com LIMIT parametrizado.
 */

const CODIGO_TIMEOUT = '57014'; // query_canceled

function comLimite(sql: string, limitParamIdx: number): string {
  const semPontoEVirgula = sql.trim().replace(/;+\s*$/, '');
  return `SELECT * FROM (\n${semPontoEVirgula}\n) AS _rows LIMIT $${limitParamIdx}`;
}

export function createPgConnector(configInput: ConnectorConfigInput): DbConnector {
  const config = ConnectorConfigSchema.parse(configInput);
  const pool = new pg.Pool({
    connectionString: config.url,
    max: config.poolMax,
    application_name: 'seta-erp-connector',
  });

  return {
    dialect: 'postgres',

    async execute(q, o: ExecOptions = {}): Promise<QueryResult> {
      const inicio = performance.now();
      const binds = NamedBindsSchema.parse(q.binds);
      const opts = ExecOptionsSchema.parse(o);
      const timeoutMs = opts.timeoutMs ?? config.statementTimeoutMs;
      const maxRows = opts.maxRows ?? config.defaultMaxRows;

      const { text, values } = toPositional(q.sql, binds);
      const textoComLimite = comLimite(text, values.length + 1);
      const valoresComLimite: Scalar[] = [...values, maxRows + 1];

      const client = await pool.connect();
      try {
        await client.query('BEGIN READ ONLY');
        await client.query({
          text: 'SELECT set_config($1, $2, true)',
          values: ['statement_timeout', String(timeoutMs)],
        });
        const res = await client.query({ text: textoComLimite, values: valoresComLimite });
        await client.query('COMMIT');

        const truncated = res.rows.length > maxRows;
        const rows = truncated ? res.rows.slice(0, maxRows) : res.rows;
        return {
          rows,
          rowCount: rows.length,
          truncated,
          latencyMs: Math.round(performance.now() - inicio),
        };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        if (err instanceof Error && 'code' in err && err.code === CODIGO_TIMEOUT) {
          throw new QueryTimeoutError(timeoutMs);
        }
        throw err;
      } finally {
        client.release();
      }
    },

    async health() {
      const inicio = performance.now();
      try {
        await pool.query('SELECT 1');
        return { ok: true, latencyMs: Math.round(performance.now() - inicio) };
      } catch {
        return { ok: false, latencyMs: Math.round(performance.now() - inicio) };
      }
    },

    async close() {
      await pool.end();
    },
  };
}
