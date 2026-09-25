import type { DadosEmissao } from '@seta/cobranca';
import { describe, expect, it } from 'vitest';
import type { PixRecebedor } from '../src/pagamentos/order-details.ts';
import type { CobrancaRow, CobrancaTituloRow } from '../src/pagamentos/repo.ts';
import { linhasQueSaem, montarTemplateCobranca } from '../src/pagamentos/template-cobranca.ts';

/**
 * Spec 043 — escolha do template por método. A aridade de cada lista é o
 * contrato do corpo aprovado na Meta: pix 3, boleto/2ª via 4, cartão 2.
 */

const NOMES = {
  pix: 'cobranca_pix',
  boleto: 'cobranca_boleto',
  boletoSegundaVia: 'boleto_segunda_via',
  cartao: 'cobranca_cartao',
};
const RECEBEDOR: PixRecebedor = {
  merchantName: 'SETA TECH LTDA',
  key: 'b1080aa2-3265-4208-b7ec-eb691fb7bdd6',
  keyType: 'EVP',
};
const COBRANCA = { id: '01a0a578-ed6f-705b-ace6-dc6f8d59fa12', contratoId: '10002' } as Pick<
  CobrancaRow,
  'id' | 'contratoId'
>;
const TITULOS = [
  {
    cobrancaId: COBRANCA.id,
    tituloId: '138',
    origem: 'saldo',
    parcela: 7,
    totalParcelas: 100,
    valorCentavos: 114_100,
    vencimento: '2026-06-27',
  } as CobrancaTituloRow,
];
const BASE: DadosEmissao = {
  metodo: 'boleto',
  valorCentavos: 114_100,
  vencimento: '2026-09-18',
  urlFatura: 'https://www.asaas.com/i/abc',
  urlBoleto: 'https://www.asaas.com/b/pdf/abc',
  linhaDigitavel: '23793381286008211720818000063305811410000114100',
  pixCopiaCola: null,
  reenvio: false,
};
const monta = (d: Partial<DadosEmissao>, nomes = NOMES) =>
  montarTemplateCobranca({ ...BASE, ...d }, COBRANCA, TITULOS, { recebedor: RECEBEDOR, nomes });

describe('spec 043 — montarTemplateCobranca', () => {
  it('boleto: 4 variáveis na ordem do corpo aprovado, sem botão', () => {
    const t = monta({});
    expect(t?.nome).toBe('cobranca_boleto');
    expect(t?.botao).toBeUndefined();
    expect(t?.variaveis).toEqual([
      'R$ 1.141,00',
      '18/09/2026',
      '23793381286008211720818000063305811410000114100',
      'https://www.asaas.com/b/pdf/abc',
    ]);
  });

  it('boleto reenviado usa o template de 2ª via, que reconhece o envio anterior', () => {
    expect(monta({ reenvio: true })?.nome).toBe('boleto_segunda_via');
  });

  it('sem PDF do banco, o link da fatura entra no lugar', () => {
    expect(monta({ urlBoleto: null })?.variaveis[3]).toBe('https://www.asaas.com/i/abc');
  });

  it('boleto sem linha digitável não manda template — o card mandaria copiar o que não veio', () => {
    expect(monta({ linhaDigitavel: null })).toBeNull();
  });

  it('pix: 3 variáveis mais o botão order_details com o copia-e-cola', () => {
    const t = monta({ metodo: 'pix', pixCopiaCola: '00020101021226820014br.gov.bcb.pix' });
    expect(t?.nome).toBe('cobranca_pix');
    expect(t?.variaveis).toEqual(['R$ 1.141,00', '18/09/2026', 'https://www.asaas.com/i/abc']);
    expect(t?.botao?.orderDetails.pix.code).toBe('00020101021226820014br.gov.bcb.pix');
    expect(t?.botao?.orderDetails.totalCentavos).toBe(114_100);
  });

  it('cartão: 2 variáveis, valor e link', () => {
    const t = monta({ metodo: 'cartao' });
    expect(t?.nome).toBe('cobranca_cartao');
    expect(t?.variaveis).toEqual(['R$ 1.141,00', 'https://www.asaas.com/i/abc']);
  });

  it('modelo não configurado no .env ⇒ sem template, e o fluxo segue por texto', () => {
    expect(monta({}, { ...NOMES, boleto: undefined })).toBeNull();
    expect(monta({ reenvio: true }, { ...NOMES, boletoSegundaVia: undefined })).toBeNull();
    expect(monta({ metodo: 'cartao' }, { ...NOMES, cartao: undefined })).toBeNull();
  });
});

describe('linhasQueSaem: o que o card já leva não sai de novo em texto', () => {
  const CODIGO = '00020101021226820014br.gov.bcb.pix';

  it('PIX: a linha do copia-e-cola some quando o código está no botão', () => {
    const template = monta({ metodo: 'pix', pixCopiaCola: CODIGO });
    expect(template?.botao?.orderDetails.pix?.code).toBe(CODIGO);

    const saem = linhasQueSaem(['Seu PIX está pronto! ⚡', CODIGO], template);

    expect(saem).toEqual(['Seu PIX está pronto! ⚡']);
  });

  it('sem template, o copia-e-cola continua — é a única forma copiável', () => {
    const semNomes = { ...NOMES, pix: '' };
    const template = monta({ metodo: 'pix', pixCopiaCola: CODIGO }, semNomes);
    expect(template).toBeNull();

    expect(linhasQueSaem(['Seu PIX está pronto! ⚡', CODIGO], template)).toHaveLength(2);
  });

  it('boleto: a linha digitável NÃO some — o card dela não tem botão de copiar', () => {
    const template = monta({});
    expect(template?.botao).toBeUndefined();
    const linhas = ['Seu boleto está pronto! 🧾', BASE.linhaDigitavel ?? ''];

    expect(linhasQueSaem(linhas, template)).toEqual(linhas);
  });
});
