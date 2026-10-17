import { join } from 'node:path';
import { CatalogLoadError, loadCatalog } from '@seta/query-catalog';
import { describe, expect, it } from 'vitest';

const CATALOG_REAL = join(import.meta.dirname, '../../../catalog');
const FIXTURES_INVALIDAS = join(import.meta.dirname, 'fixtures-invalidas');

describe('loader do catálogo', () => {
  it('carrega o catálogo real do repo: 8 da 012 + 1 da 014 + 2 comerciais da 015 + 2 internas da 040', () => {
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
      'financeiro.parcela_por_mes',
      'financeiro.parcela_por_numero',
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
      // `parcela_por_numero` é a única que não vira tool do modelo: é a
      // VERIFICAÇÃO que o servidor faz antes de buscar o PDF (040), e é ela que
      // traduz o NÚMERO da parcela (o que o cotista fala) para a linha do ERP —
      // o agente chama `enviar_segunda_via`, nunca esta. `proximas_parcelas`
      // deixou de ser interna na 040: sem enxergar a lista, o modelo só alcança
      // a próxima parcela e as vencidas.
      //
      // #36: `parcela_por_mes` é a irmã dela e nasce interna pelo mesmo motivo
      // — ela é que torna possível o critério de aceite da 040 ("a segunda via
      // da parcela de março"), porque num contrato de 88 parcelas o cotista
      // aponta pelo mês, não pelo número que ele não decorou.
      const internas = ['financeiro.parcela_por_numero', 'financeiro.parcela_por_mes'];
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
