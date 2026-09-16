import { type Scalar, toPositional } from '@seta/erp-connector';
import pg from 'pg';

/**
 * Acesso ao `erp_mock` pelo papel `tse_sim` (035): SELECT/INSERT/UPDATE nas
 * tabelas físicas, ZERO nas views canônicas — quem lê o ERP pelo produto é o
 * `erp_ro`, e o simulador não atravessa essa fronteira nem para depurar.
 *
 * `toPositional` é o mesmo conversor de binds NOMEADOS que o resto do repo usa:
 * valor em SQL nunca entra por interpolação, em camada nenhuma.
 */
export interface Consulta {
  buscar<T>(sql: string, binds?: Readonly<Record<string, Scalar>>): Promise<T[]>;
}

export interface Banco extends Consulta {
  transacao<T>(fn: (tx: Consulta) => Promise<T>): Promise<T>;
  fechar(): Promise<void>;
}

function executor(cliente: pg.Pool | pg.PoolClient): Consulta {
  return {
    async buscar<T>(sql: string, binds: Readonly<Record<string, Scalar>> = {}): Promise<T[]> {
      const { text, values } = toPositional(sql, binds);
      const r = await cliente.query({ text, values: values as Scalar[] });
      return r.rows as T[];
    },
  };
}

export function criarBanco(url: string): Banco {
  const pool = new pg.Pool({ connectionString: url, max: 5, statement_timeout: 5_000 });
  const base = executor(pool);
  return {
    buscar: base.buscar,
    async transacao<T>(fn: (tx: Consulta) => Promise<T>): Promise<T> {
      const cliente = await pool.connect();
      try {
        await cliente.query('BEGIN');
        const saida = await fn(executor(cliente));
        await cliente.query('COMMIT');
        return saida;
      } catch (err) {
        await cliente.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        cliente.release();
      }
    },
    fechar: () => pool.end(),
  };
}
