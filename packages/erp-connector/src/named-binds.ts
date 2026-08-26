import type { Scalar } from './index.js';

/**
 * Converte SQL com binds nomeados (`:nome`) em texto posicional (`$1..$n`) + values.
 * Estrito nos dois sentidos: token sem bind e bind sem token são erros — pega typo
 * antes de chegar no banco. `::cast` do Postgres não é tratado como bind.
 */

const TOKEN = /(?<![:\w]):([a-zA-Z_][a-zA-Z0-9_]*)/g;

export interface PositionalQuery {
  readonly text: string;
  readonly values: readonly Scalar[];
}

export function toPositional(
  sql: string,
  binds: Readonly<Record<string, Scalar>>,
): PositionalQuery {
  const indexPorNome = new Map<string, number>();
  const values: Scalar[] = [];

  const text = sql.replace(TOKEN, (_m, nome: string) => {
    if (!Object.hasOwn(binds, nome)) {
      throw new Error(`bind ausente para o token :${nome}`);
    }
    let idx = indexPorNome.get(nome);
    if (idx === undefined) {
      values.push(binds[nome] as Scalar);
      idx = values.length;
      indexPorNome.set(nome, idx);
    }
    return `$${idx}`;
  });

  const naoUsados = Object.keys(binds).filter((nome) => !indexPorNome.has(nome));
  if (naoUsados.length > 0) {
    throw new Error(`binds sem token correspondente no SQL: ${naoUsados.join(', ')}`);
  }

  return { text, values };
}
