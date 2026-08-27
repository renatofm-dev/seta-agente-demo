import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { parse } from 'yaml';
import { MASKERS } from './masking.js';
import { type CatalogEntry, CatalogEntrySchema } from './schema.js';
import { validateEntrySql } from './validate-sql.js';

/**
 * Loader do catálogo: lê catalog/ recursivamente, valida com Zod + validador
 * estático de SQL e indexa por id. QUALQUER entrada inválida derruba o boot,
 * com todos os erros agregados de uma vez.
 */

export interface CatalogIndex {
  get(id: string): CatalogEntry;
  has(id: string): boolean;
  list(): readonly CatalogEntry[];
}

export class CatalogLoadError extends Error {
  constructor(public readonly erros: readonly string[]) {
    super(`catálogo inválido (${erros.length} erro(s)):\n- ${erros.join('\n- ')}`);
    this.name = 'CatalogLoadError';
  }
}

export function loadCatalog(dir: string): CatalogIndex {
  const arquivos = readdirSync(dir, { recursive: true, encoding: 'utf-8' })
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .sort();

  const erros: string[] = [];
  const porId = new Map<string, CatalogEntry>();

  for (const arquivo of arquivos) {
    const caminho = join(dir, arquivo);
    let entry: CatalogEntry;
    try {
      entry = CatalogEntrySchema.parse(parse(readFileSync(caminho, 'utf-8')));
    } catch (err) {
      erros.push(`${arquivo}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
      continue;
    }

    // id deve refletir o caminho: catalog/<dominio>/<nome>.yaml → dominio.nome
    const esperado = relative('.', arquivo)
      .replace(/\.(yaml|yml)$/, '')
      .split(sep)
      .join('.');
    if (entry.id !== esperado) {
      erros.push(
        `${arquivo}: id "${entry.id}" não corresponde ao caminho (esperado "${esperado}")`,
      );
    }
    if (porId.has(entry.id)) {
      erros.push(`${arquivo}: id duplicado "${entry.id}"`);
    }
    for (const masker of Object.values(entry.output.masking)) {
      if (!(masker in MASKERS)) erros.push(`${arquivo}: masker desconhecido "${masker}"`);
    }
    for (const e of validateEntrySql(entry)) {
      erros.push(`${arquivo}: ${e}`);
    }
    porId.set(entry.id, entry);
  }

  if (arquivos.length === 0) erros.push(`nenhuma entrada .yaml encontrada em ${dir}`);
  if (erros.length > 0) throw new CatalogLoadError(erros);

  return {
    get(id) {
      const entry = porId.get(id);
      if (!entry) throw new Error(`entrada de catálogo inexistente: ${id}`);
      return entry;
    },
    has: (id) => porId.has(id),
    list: () => [...porId.values()],
  };
}
