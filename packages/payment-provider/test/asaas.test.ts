import {
  ambienteDaUrl,
  centavosParaReais,
  createAsaasProvider,
  PspAuthError,
  PspBusinessError,
  PspUnavailableError,
  reaisParaCentavos,
  statusDoAsaas,
} from '@seta/payment-provider';
import { describe, expect, it } from 'vitest';

interface Chamada {
  url: string;
  init?: RequestInit;
}

/** fetch fake: fila de respostas (uma por chamada) + registro das chamadas. */
function fetchFake(respostas: { corpo?: unknown; status?: number; falha?: Error }[]) {
  const chamadas: Chamada[] = [];
  const fila = [...respostas];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    chamadas.push({ url: String(url), init });
    const r = fila.shift();
    if (!r) throw new Error('fetchFake: fila vazia');
    if (r.falha) throw r.falha;
    return new Response(r.corpo === undefined ? '' : JSON.stringify(r.corpo), {
      status: r.status ?? 200,
    });
  }) as typeof fetch;
  return { fn, chamadas };
}

const CONFIG = { baseUrl: 'https://api-sandbox.asaas.com/v3', apiKey: 'chave-sandbox' };

const PAYMENT_DTO = {
  id: 'pay_1',
  status: 'PENDING',
  value: 850.5,
  dueDate: '2026-09-05',
  invoiceUrl: 'https://sandbox.asaas.com/i/pay_1',
  bankSlipUrl: 'https://sandbox.asaas.com/b/pdf/pay_1',
  externalReference: 'contrato:10002:titulos:7',
};

describe('spec 014 — conversão de dinheiro na borda', () => {
  it('centavos ↔ reais sem perder centavo', () => {
    expect(centavosParaReais(85050)).toBe(850.5);
    expect(centavosParaReais(1)).toBe(0.01);
    expect(reaisParaCentavos(850.5)).toBe(85050);
    expect(reaisParaCentavos(0.29)).toBe(29); // 0.29*100 = 28.999… sem round
    expect(reaisParaCentavos(centavosParaReais(123456789))).toBe(123456789);
  });

  it('ambiente sai da base URL; status desconhecido nunca vira pago', () => {
    expect(ambienteDaUrl('https://api-sandbox.asaas.com/v3')).toBe('sandbox');
    expect(ambienteDaUrl('https://api.asaas.com/v3')).toBe('producao');
    expect(statusDoAsaas('RECEIVED')).toBe('recebida');
    expect(statusDoAsaas('CONFIRMED')).toBe('confirmada');
    expect(statusDoAsaas('OVERDUE')).toBe('vencida');
    expect(statusDoAsaas('PENDING', true)).toBe('cancelada');
    expect(statusDoAsaas('ALGO_NOVO')).toBe('desconhecida');
  });
});

describe('spec 014 — adapter Asaas (fetch)', () => {
  it('manda access_token + User-Agent e cria a cobrança em reais com dueDate', async () => {
    const { fn, chamadas } = fetchFake([{ corpo: PAYMENT_DTO }]);
    const psp = createAsaasProvider({ ...CONFIG, fetchFn: fn });
    expect(psp.ambiente).toBe('sandbox');

    const c = await psp.criarCobranca({
      clienteId: 'cus_1',
      valorCentavos: 85050,
      vencimento: '2026-09-05',
      descricao: 'Contrato 10002 — parcela 12/120',
      referenciaExterna: 'contrato:10002:titulos:7',
      metodo: 'pix',
    });

    const headers = chamadas[0]?.init?.headers as Record<string, string>;
    expect(headers.access_token).toBe('chave-sandbox');
    expect(headers['user-agent']).toMatch(/seta-agente/);
    expect(headers.authorization).toBeUndefined(); // Asaas NÃO usa Bearer
    expect(chamadas[0]?.url).toBe('https://api-sandbox.asaas.com/v3/payments');
    const body = JSON.parse(String(chamadas[0]?.init?.body));
    expect(body).toEqual({
      customer: 'cus_1',
      billingType: 'PIX',
      value: 850.5,
      dueDate: '2026-09-05',
      description: 'Contrato 10002 — parcela 12/120',
      externalReference: 'contrato:10002:titulos:7',
    });
    expect(c).toEqual({
      id: 'pay_1',
      status: 'pendente',
      statusBruto: 'PENDING',
      valorCentavos: 85050,
      vencimento: '2026-09-05',
      urlFatura: 'https://sandbox.asaas.com/i/pay_1',
      urlBoleto: 'https://sandbox.asaas.com/b/pdf/pay_1',
      referenciaExterna: 'contrato:10002:titulos:7',
    });
  });

  it('garantirCliente busca por referência, depois por CPF, e só então cria', async () => {
    const { fn, chamadas } = fetchFake([
      { corpo: { data: [] } }, // por externalReference
      { corpo: { data: [] } }, // por cpfCnpj
      { corpo: { id: 'cus_novo' } }, // POST
    ]);
    const psp = createAsaasProvider({ ...CONFIG, fetchFn: fn });
    const r = await psp.garantirCliente({
      documento: '12345678909',
      nome: 'Titular do contrato 10002',
      referenciaExterna: 'contrato:10002',
    });
    expect(r).toEqual({ id: 'cus_novo' });
    expect(chamadas[0]?.url).toContain('/customers?externalReference=contrato%3A10002');
    expect(chamadas[1]?.url).toContain('/customers?cpfCnpj=12345678909');
    expect(chamadas[2]?.init?.method).toBe('POST');
    const body = JSON.parse(String(chamadas[2]?.init?.body));
    expect(body).toMatchObject({
      name: 'Titular do contrato 10002',
      cpfCnpj: '12345678909',
      externalReference: 'contrato:10002',
      notificationDisabled: true,
    });

    // já existe ⇒ nenhum POST
    const existente = fetchFake([{ corpo: { data: [{ id: 'cus_1' }] } }]);
    const psp2 = createAsaasProvider({ ...CONFIG, fetchFn: existente.fn });
    await expect(
      psp2.garantirCliente({
        documento: '12345678909',
        nome: 'X',
        referenciaExterna: 'contrato:1',
      }),
    ).resolves.toEqual({ id: 'cus_1' });
    expect(existente.chamadas).toHaveLength(1);
  });

  it('buscarPorReferencia lê o envelope de lista e prefere a cobrança aberta', async () => {
    const { fn } = fetchFake([
      {
        corpo: {
          object: 'list',
          hasMore: false,
          data: [
            { ...PAYMENT_DTO, id: 'pay_velha', status: 'PENDING', deleted: true },
            { ...PAYMENT_DTO, id: 'pay_aberta', status: 'PENDING' },
          ],
        },
      },
      { corpo: { data: [] } },
    ]);
    const psp = createAsaasProvider({ ...CONFIG, fetchFn: fn });
    const r = await psp.buscarPorReferencia('contrato:10002:titulos:7');
    expect(r?.id).toBe('pay_aberta');
    await expect(psp.buscarPorReferencia('nada')).resolves.toBeNull();
  });

  it('PIX, linha digitável, cancelar e simular recebimento batem nos endpoints certos', async () => {
    const { fn, chamadas } = fetchFake([
      {
        corpo: { encodedImage: 'AAA', payload: '00020126…', expirationDate: '2026-09-05 23:59:59' },
      },
      {
        corpo: {
          identificationField: '23790.00000 00000.000000 00000.000000 0 00000000085050',
          barCode: '2379…',
        },
      },
      { corpo: {} },
      { corpo: { ...PAYMENT_DTO, status: 'RECEIVED_IN_CASH' } },
    ]);
    const psp = createAsaasProvider({ ...CONFIG, fetchFn: fn });

    await expect(psp.obterPix('pay_1')).resolves.toEqual({
      payload: '00020126…',
      expiraEm: '2026-09-05 23:59:59',
    });
    expect(chamadas[0]?.url).toContain('/payments/pay_1/pixQrCode');

    const linha = await psp.obterLinhaDigitavel('pay_1');
    expect(linha.linhaDigitavel).toMatch(/^23790/);
    expect(chamadas[1]?.url).toContain('/payments/pay_1/identificationField');

    await psp.cancelarCobranca('pay_1');
    expect(chamadas[2]?.init?.method).toBe('DELETE');
    expect(chamadas[2]?.url).toContain('/payments/pay_1');

    await psp.simularRecebimento('pay_1', 85050);
    expect(chamadas[3]?.url).toContain('/payments/pay_1/receiveInCash');
    const body = JSON.parse(String(chamadas[3]?.init?.body));
    expect(body).toMatchObject({ value: 850.5, notifyCustomer: false });
    expect(body.paymentDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('erros: 401 ⇒ auth, 400 ⇒ negócio (com a descrição do Asaas), 500/rede ⇒ indisponível', async () => {
    const auth = createAsaasProvider({
      ...CONFIG,
      fetchFn: fetchFake([{ status: 401, corpo: { errors: [{ code: 'invalid_api_key' }] } }]).fn,
    });
    await expect(auth.buscarPorReferencia('x')).rejects.toBeInstanceOf(PspAuthError);

    const negocio = createAsaasProvider({
      ...CONFIG,
      fetchFn: fetchFake([
        {
          status: 400,
          corpo: { errors: [{ code: 'invalid_action', description: 'Cliente inválido.' }] },
        },
      ]).fn,
    });
    const err = await negocio
      .criarCobranca({
        clienteId: 'cus_x',
        valorCentavos: 100,
        vencimento: '2026-09-05',
        descricao: 'd',
        referenciaExterna: 'r',
        metodo: 'boleto',
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PspBusinessError);
    expect((err as PspBusinessError).detalhes).toEqual(['Cliente inválido.']);

    const fora = createAsaasProvider({ ...CONFIG, fetchFn: fetchFake([{ status: 503 }]).fn });
    await expect(fora.buscarPorReferencia('x')).rejects.toBeInstanceOf(PspUnavailableError);

    const rede = createAsaasProvider({
      ...CONFIG,
      fetchFn: fetchFake([{ falha: new TypeError('fetch failed') }]).fn,
    });
    await expect(rede.buscarPorReferencia('x')).rejects.toBeInstanceOf(PspUnavailableError);

    const { ok } = await rede.health().catch(() => ({ ok: false }));
    expect(ok).toBe(false);
  });

  it('valida a entrada com Zod antes de chamar o gateway', async () => {
    const { fn, chamadas } = fetchFake([]);
    const psp = createAsaasProvider({ ...CONFIG, fetchFn: fn });
    await expect(
      psp.criarCobranca({
        clienteId: 'cus_1',
        valorCentavos: -1,
        vencimento: '05/09/2026',
        descricao: 'd',
        referenciaExterna: 'r',
        metodo: 'pix',
      }),
    ).rejects.toThrow();
    await expect(
      psp.garantirCliente({ documento: '123', nome: 'X', referenciaExterna: 'r' }),
    ).rejects.toThrow();
    expect(chamadas).toHaveLength(0);
  });
});
