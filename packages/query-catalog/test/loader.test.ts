import { join } from 'node:path';
import { CatalogLoadError, loadCatalog } from '@seta/query-catalog';
import { describe, expect, it } from 'vitest';

const CATALOG_REAL = join(import.meta.dirname, '../../../catalog');
const FIXTURES_INVALIDAS = join(import.meta.dirname, 'fixtures-invalidas');

describe('loader do catálogo', () => {
  it('carrega o catálogo real do repo: 8 da 012 + 1 interna da 014 + 2 comerciais da 015 + 1 da 040', () => {
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
      'financeiro.boleto_da_parcela',
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
      // Duas entradas NÃO viram tool do modelo: `proximas_parcelas` é uso interno
      // do fluxo/conciliação (014) e `boleto_da_parcela` é a VERIFICAÇÃO que o
      // servidor faz antes de buscar o PDF (040) — o agente chama
      // `enviar_segunda_via`, não esta.
      const internas = ['financeiro.proximas_parcelas', 'financeiro.boleto_da_parcela'];
      expect(entry.tool.expose).toBe(!internas.includes(entry.id));
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
