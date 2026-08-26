import { bindTokens, toPositional } from '@seta/erp-connector';
import pkg from 'node-sql-parser';
import type { CatalogEntry } from './schema.js';

const { Parser } = pkg;

/**
 * Validador estático de SQL do catálogo (roda no loader E como teste):
 * 1 statement, só SELECT, só views canônicas, só binds `:nome` (nada de
 * interpolação `${}` nem placeholder cru), binds ⇔ params nos dois sentidos.
 */

export const CANONICAL_VIEWS = [
  'v_cliente',
  'v_pedido',
  'v_item_pedido',
  'v_titulo',
  'v_estoque',
  'v_tabela_preco',
] as const;

/** Params de sessão que o executor sabe resolver (validado no load). */
export const KNOWN_SESSION_PARAMS = ['cliente_id'] as const;

const parser = new Parser();

export function validateEntrySql(entry: CatalogEntry): string[] {
  const erros: string[] = [];
  const { sql, params } = entry;

  if (sql.includes('${')) {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a mensagem descreve o padrão proibido
    erros.push('interpolação `${}` é proibida — use binds `:nome`');
  }
  if (/\$\d+/.test(sql) || /(?<![\w:'])\?/.test(sql)) {
    erros.push('placeholder posicional cru ($n / ?) é proibido — use binds `:nome`');
  }

  const tokens = bindTokens(sql);
  const nomesParams = Object.keys(params);
  for (const t of tokens) {
    if (!nomesParams.includes(t)) erros.push(`bind :${t} sem param declarado`);
  }
  for (const p of nomesParams) {
    if (!tokens.includes(p)) erros.push(`param "${p}" declarado sem bind :${p} no SQL`);
  }
  for (const [nome, spec] of Object.entries(params)) {
    if (spec.source === 'session' && !KNOWN_SESSION_PARAMS.includes(nome as never)) {
      erros.push(
        `param de sessão desconhecido: "${nome}" (executor só resolve ${KNOWN_SESSION_PARAMS.join(', ')})`,
      );
    }
  }

  // parse estrutural: converte :nome → $n só para o parser
  const dummy = Object.fromEntries(tokens.map((t) => [t, null]));
  let ast: unknown;
  try {
    ast = parser.astify(toPositional(sql, dummy).text, { database: 'Postgresql' });
  } catch (err) {
    erros.push(
      `SQL não parseia: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`,
    );
    return erros;
  }

  const statements = Array.isArray(ast) ? ast : [ast];
  if (statements.length > 1) {
    erros.push(`mais de um statement (${statements.length}) — só um SELECT por entrada`);
  }
  for (const stmt of statements as { type?: string }[]) {
    if (stmt.type !== 'select') {
      erros.push(`statement "${stmt.type}" proibido — só SELECT`);
    }
  }

  // allowlist de objetos: só views canônicas
  try {
    const tabelas = parser.tableList(toPositional(sql, dummy).text, { database: 'Postgresql' });
    for (const ref of tabelas) {
      const [op, , nome] = ref.split('::');
      if (op !== 'select') erros.push(`operação "${op}" em ${nome} proibida`);
      if (!CANONICAL_VIEWS.includes(nome as never)) {
        erros.push(`objeto "${nome}" fora da allowlist de views canônicas`);
      }
    }
  } catch {
    // astify acima já reportou erro de parse
  }

  // masking só sobre colunas declaradas
  for (const col of Object.keys(entry.output.masking)) {
    if (!entry.output.columns.includes(col)) {
      erros.push(`masking em coluna "${col}" que não está em output.columns`);
    }
  }

  return erros;
}
