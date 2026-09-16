import { describe, expect, it } from 'vitest';
import { codigoAutorizacao, createTseErpApi, ErpBusinessError } from '../src/index.ts';
import { criarFakeTse, fixture } from './fake-tse.ts';

/**
 * O adapter contra os exemplos REAIS do fornecedor (fixtures da 035). Sem rede:
 * o que se prova aqui é que entendemos o que o TSE responde — inclusive quando
 * ele responde prosa com HTTP 200.
 */

const CONFIG = { baseUrl: 'http://tse.local', username: 'u', password: 'p' };

const TRANSACAO = 'POST /api/financeiro/TransacaoEletronica';
const FINANCEIRO = 'GET /api/PainelDoCliente/FinanceiroContrato';

function api(fake: ReturnType<typeof criarFakeTse>) {
  return createTseErpApi({ ...CONFIG, fetchFn: fake.fetchFn, esperar: async () => {} });
}

const BAIXA = {
  contaFinanceiraId: '20453',
  contratoId: '273',
  valorCentavos: 6668,
  metodo: 'pix' as const,
  referenciaPsp: 'pay_yjpuup1ic7tn42tb',
};

describe('registrarPagamento', () => {
  it('extrai o id da PROSA que o TSE devolve (a fixture do fornecedor)', async () => {
    const fake = criarFakeTse();
    fake.responder(TRANSACAO, { body: fixture('financial__post-eletronic-transaction').body });

    const r = await api(fake).registrarPagamento(BAIXA);

    expect(r.transacaoId).toBe('1');
  });

  it('HTTP 200 NÃO é prova de sucesso: prosa inesperada vira ErpBusinessError', async () => {
    const fake = criarFakeTse();
    fake.responder(TRANSACAO, { body: 'Conta financeira já quitada.' });

    await expect(api(fake).registrarPagamento(BAIXA)).rejects.toBeInstanceOf(ErpBusinessError);
  });

  it('PIX e boleto vão com os campos de cartão NULOS e o id do PSP na autorização', async () => {
    const fake = criarFakeTse();
    fake.responder(TRANSACAO, { body: 'Transação inserida com sucesso, sob id: 7' });

    await api(fake).registrarPagamento(BAIXA);

    const enviado = fake.chamadas.at(-1)?.body as Record<string, unknown>;
    expect(enviado).toMatchObject({
      IdContaFinanceira: 20_453,
      Valor: 66.68,
      QuatroPrimeirosDigitosCartao: null,
      QuatroUltimosDigitosCartao: null,
      CodigoAutorizacao: 'pay_yjpuup1ic7tn42tb',
      QuantidadeParcelas: 1,
    });
  });

  it('dinheiro sai em decimal a partir de centavos, sem float', async () => {
    const fake = criarFakeTse();
    fake.responder(TRANSACAO, { body: 'Transação inserida com sucesso, sob id: 8' });

    await api(fake).registrarPagamento({ ...BAIXA, valorCentavos: 187_500 });

    expect(fake.chamadas.at(-1)?.body).toMatchObject({ Valor: 1875 });
  });

  it('escrita NÃO re-tenta sozinha: rede caída sobe o erro para o worker decidir', async () => {
    const fake = criarFakeTse();
    fake.responder(TRANSACAO, { body: 'Transação inserida com sucesso, sob id: 9' });
    fake.derrubar(TRANSACAO, 1);

    await expect(api(fake).registrarPagamento(BAIXA)).rejects.toThrow(/sem resposta/);
    expect(fake.chamadas.filter((c) => c.url.includes('TransacaoEletronica'))).toHaveLength(1);
  });
});

describe('codigoAutorizacao', () => {
  it('id do PSP cabe inteiro (o `pay_…` do Asaas tem 18 caracteres)', () => {
    expect(codigoAutorizacao('pay_yjpuup1ic7tn42tb')).toBe('pay_yjpuup1ic7tn42tb');
  });

  it('acima do limite vira hash curto DETERMINÍSTICO, não truncamento cego', () => {
    const longo = 'x'.repeat(80);
    const a = codigoAutorizacao(longo, 12);
    expect(a).toHaveLength(12);
    expect(a).not.toBe(longo.slice(0, 12));
    expect(codigoAutorizacao(longo, 12)).toBe(a);
  });
});

describe('lerParcela (read-back)', () => {
  it('acha a parcela na página e converte para centavos', async () => {
    const fake = criarFakeTse();
    fake.responder(FINANCEIRO, { body: fixture('client-area__contract-installments').body });

    const p = await api(fake).lerParcela('20453', '273');

    expect(p).toMatchObject({ contaFinanceiraId: '20453', contratoId: '273', pago: false });
    expect(p?.valorCentavos).toBe(6668);
  });

  it('varre as páginas seguintes antes de desistir', async () => {
    const fake = criarFakeTse();
    fake.responder(FINANCEIRO, {
      body: { ListaDados: [], TotalPaginas: 3 },
    });

    expect(await api(fake).lerParcela('999999', '273')).toBeNull();
    expect(fake.chamadas.filter((c) => c.url.includes('FinanceiroContrato'))).toHaveLength(3);
  });

  it('pede pelo IdContrato, NUNCA pelo NumeroContrato — trocar vaza o financeiro alheio', async () => {
    const fake = criarFakeTse();
    fake.responder(FINANCEIRO, { body: fixture('client-area__contract-installments').body });

    await api(fake).lerParcela('20453', '273');

    const url = new URL(fake.chamadas.at(-1)?.url as string);
    expect(url.searchParams.get('idContrato')).toBe('273');
  });
});
