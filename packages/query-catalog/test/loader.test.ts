import { join } from 'node:path';
import { CatalogLoadError, loadCatalog } from '@seta/query-catalog';
import { describe, expect, it } from 'vitest';

const CATALOG_REAL = join(import.meta.dirname, '../../../catalog');
const FIXTURES_INVALIDAS = join(import.meta.dirname, 'fixtures-invalidas');

describe('loader do catálogo', () => {
  it('carrega o catálogo real do repo com as 8 entradas da spec 012', () => {
    const catalog = loadCatalog(CATALOG_REAL);
    const ids = catalog
      .list()
      .map((e) => e.id)
      .sort();
    expect(ids).toEqual([
      'atendimento.meu_chamado',
      'contrato.meu_produto',
      'contrato.minha_cota',
      'contrato.status_cancelamento',
      'financeiro.proxima_parcela',
      'financeiro.saldo_contrato',
      'financeiro.titulos_atraso',
      'financeiro.total_pago',
    ]);
    // toda entrada amarra no contrato da sessão — nunca em param do modelo
    for (const entry of catalog.list()) {
      expect(entry.params.contrato_id?.source).toBe('session');
      expect(entry.tool.expose).toBe(true);
      expect(entry.price_source).toBe(false); // não há price_source neste domínio
    }
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
