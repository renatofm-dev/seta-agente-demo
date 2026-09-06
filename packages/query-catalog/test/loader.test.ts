import { join } from 'node:path';
import { CatalogLoadError, loadCatalog } from '@seta/query-catalog';
import { describe, expect, it } from 'vitest';

const CATALOG_REAL = join(import.meta.dirname, '../../../catalog');
const FIXTURES_INVALIDAS = join(import.meta.dirname, 'fixtures-invalidas');

describe('loader do catálogo', () => {
  it('carrega o catálogo real do repo: 8 entradas da 012 + 1 interna da 014 + 2 comerciais da 015', () => {
    const catalog = loadCatalog(CATALOG_REAL);
    const ids = catalog
      .list()
      .map((e) => e.id)
      .sort();
    expect(ids).toEqual([
      'atendimento.meu_chamado',
      'comercial.condicoes_cota',
      'comercial.estoque_disponivel',
      'contrato.meu_produto',
      'contrato.minha_cota',
      'contrato.status_cancelamento',
      'financeiro.proxima_parcela',
      'financeiro.proximas_parcelas',
      'financeiro.saldo_contrato',
      'financeiro.titulos_atraso',
      'financeiro.total_pago',
    ]);
    // entrada grão-contrato amarra no contrato da sessão — nunca em param do modelo;
    // 015: as comerciais não têm contrato_id (são as únicas legíveis sem vínculo)
    for (const entry of catalog.list()) {
      if (entry.id.startsWith('comercial.')) {
        expect(entry.params.contrato_id).toBeUndefined();
      } else {
        expect(entry.params.contrato_id?.source).toBe('session');
      }
      // 014: proximas_parcelas é uso interno (fluxo/conciliação), não vira tool do modelo
      expect(entry.tool.expose).toBe(entry.id !== 'financeiro.proximas_parcelas');
      // 015: condicoes_cota é a primeira price_source — a alçada do SDR emerge dela
      expect(entry.price_source).toBe(entry.id === 'comercial.condicoes_cota');
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
