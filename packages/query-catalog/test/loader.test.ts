import { join } from 'node:path';
import { CatalogLoadError, loadCatalog } from '@seta/query-catalog';
import { describe, expect, it } from 'vitest';

const CATALOG_REAL = join(import.meta.dirname, '../../../catalog');
const FIXTURES_INVALIDAS = join(import.meta.dirname, 'fixtures-invalidas');

describe('loader do catálogo', () => {
  it('carrega o catálogo real do repo com as 6 entradas iniciais', () => {
    const catalog = loadCatalog(CATALOG_REAL);
    const ids = catalog
      .list()
      .map((e) => e.id)
      .sort();
    expect(ids).toEqual([
      'cliente.perfil',
      'estoque.disponibilidade',
      'financeiro.titulos_abertos',
      'preco.tabela_vigente',
      'vendas.status_pedido',
      'vendas.ultimos_pedidos',
    ]);
    expect(catalog.get('preco.tabela_vigente').price_source).toBe(true);
    expect(catalog.get('cliente.perfil').output.masking).toEqual({ documento: 'cnpj' });
  });

  it('critério 003: interpolação, DDL e tabela física são rejeitados no load', () => {
    let erro: CatalogLoadError | undefined;
    try {
      loadCatalog(FIXTURES_INVALIDAS);
    } catch (e) {
      erro = e as CatalogLoadError;
    }
    expect(erro).toBeInstanceOf(CatalogLoadError);
    const mensagens = erro?.erros.join('\n') ?? '';
    expect(mensagens).toMatch(/interpolação/);
    expect(mensagens).toMatch(/fora da allowlist/);
    expect(mensagens).toMatch(/"drop" proibido/);
  });

  it('id inexistente é erro claro', () => {
    const catalog = loadCatalog(CATALOG_REAL);
    expect(() => catalog.get('nao.existe')).toThrow(/inexistente/);
  });
});
