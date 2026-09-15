import { describe, expect, it } from 'vitest';
import { montarBotaoPix, type PixRecebedor } from '../src/pagamentos/order-details.ts';
import type { CobrancaRow, CobrancaTituloRow } from '../src/pagamentos/repo.ts';

/** Spec 043 — a cobrança emitida vira o pedido do botão. Função pura, sem banco. */

const RECEBEDOR: PixRecebedor = {
  merchantName: 'SETA TECH LTDA',
  key: 'b1080aa2-3265-4208-b7ec-eb691fb7bdd6',
  keyType: 'EVP',
};

const COBRANCA = {
  id: '01a0a578-ed6f-705b-ace6-dc6f8d59fa12',
  contratoId: '10002',
  metodo: 'pix',
  valorCentavos: 114_100,
  pixCopiaCola: '00020101021226820014br.gov.bcb.pix2560pix-h.asaas.com/qr/cobv/abc',
} as Pick<CobrancaRow, 'id' | 'contratoId' | 'metodo' | 'valorCentavos' | 'pixCopiaCola'>;

const titulo = (id: string, centavos: number, parcela: number): CobrancaTituloRow =>
  ({
    cobrancaId: COBRANCA.id,
    tituloId: id,
    origem: 'saldo',
    parcela,
    totalParcelas: 100,
    valorCentavos: centavos,
    vencimento: '2026-06-27',
  }) as CobrancaTituloRow;

describe('spec 043 — montarBotaoPix', () => {
  it('um item por título, valores em centavos e referência = id da cobrança', () => {
    const b = montarBotaoPix(COBRANCA, [titulo('138', 114_100, 7)], RECEBEDOR);
    expect(b?.orderDetails.referenceId).toBe(COBRANCA.id);
    expect(b?.orderDetails.totalCentavos).toBe(114_100);
    expect(b?.orderDetails.itens).toHaveLength(1);
    expect(b?.orderDetails.itens[0]).toMatchObject({ retailerId: '138', valorCentavos: 114_100 });
    expect(b?.orderDetails.pix).toMatchObject({
      code: COBRANCA.pixCopiaCola,
      merchantName: 'SETA TECH LTDA',
      keyType: 'EVP',
    });
  });

  it('vários títulos viram vários itens somando o total', () => {
    const b = montarBotaoPix(
      { ...COBRANCA, valorCentavos: 228_200 },
      [titulo('138', 114_100, 7), titulo('139', 114_100, 8)],
      RECEBEDOR,
    );
    expect(b?.orderDetails.itens).toHaveLength(2);
    const soma = b?.orderDetails.itens.reduce((s, i) => s + i.valorCentavos, 0);
    expect(soma).toBe(228_200);
  });

  it('soma divergente do total colapsa num item só — a Meta recusa soma que não fecha', () => {
    // juros/multa fariam a soma dos títulos ficar abaixo do total da cobrança
    const b = montarBotaoPix(
      { ...COBRANCA, valorCentavos: 120_000 },
      [titulo('138', 114_100, 7)],
      RECEBEDOR,
    );
    expect(b?.orderDetails.itens).toHaveLength(1);
    expect(b?.orderDetails.itens[0]).toMatchObject({
      valorCentavos: 120_000,
      nome: 'Parcelas do contrato 10002',
    });
  });

  it('boleto e cartão não têm botão — não são pagáveis dentro do WhatsApp', () => {
    expect(
      montarBotaoPix({ ...COBRANCA, metodo: 'boleto' }, [titulo('138', 114_100, 7)], RECEBEDOR),
    ).toBeNull();
    expect(
      montarBotaoPix({ ...COBRANCA, metodo: 'cartao' }, [titulo('138', 114_100, 7)], RECEBEDOR),
    ).toBeNull();
  });

  it('sem copia-e-cola, sem recebedor ou sem títulos devolve null em vez de lançar', () => {
    expect(
      montarBotaoPix({ ...COBRANCA, pixCopiaCola: null }, [titulo('138', 114_100, 7)], RECEBEDOR),
    ).toBeNull();
    expect(montarBotaoPix(COBRANCA, [titulo('138', 114_100, 7)], null)).toBeNull();
    expect(montarBotaoPix(COBRANCA, [], RECEBEDOR)).toBeNull();
  });
});
