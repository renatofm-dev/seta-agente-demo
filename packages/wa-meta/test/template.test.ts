import {
  createMetaGateway,
  createMetaTemplateApi,
  OrderDetailsSchema,
  payloadDeTemplate,
  TemplateDefSchema,
  variaveisDoCorpo,
} from '@seta/wa-meta';
import { describe, expect, it } from 'vitest';

/** fetch fake que grava a chamada e devolve a resposta configurada. */
function fetchFake(resposta: unknown, status = 200) {
  const chamadas: { url: string; init?: RequestInit }[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    chamadas.push({ url: String(url), init });
    return new Response(JSON.stringify(resposta), { status });
  }) as typeof fetch;
  return { fn, chamadas };
}

describe('spec 013 — definição de template', () => {
  it('valida nome, categoria e variáveis sequenciais', () => {
    const ok = TemplateDefSchema.parse({
      nome: 'aviso_parcela',
      corpo: 'Olá {{1}}, sua parcela vence em {{2}}.',
      rodape: 'Mirante da Serra',
    });
    expect(ok.idioma).toBe('pt_BR');
    expect(ok.categoria).toBe('utility');

    expect(TemplateDefSchema.safeParse({ nome: 'Nome Ruim', corpo: 'x' }).success).toBe(false);
    // variável fora de sequência ({{1}} pulando para {{3}})
    expect(TemplateDefSchema.safeParse({ nome: 'ok', corpo: 'Oi {{1}} e {{3}}' }).success).toBe(
      false,
    );
    expect(variaveisDoCorpo('a {{2}} b {{1}} c {{2}}')).toEqual([1, 2]);
  });
});

describe('spec 013 — TemplateApi (Graph API do WABA)', () => {
  it('criar envia components BODY(+example)/FOOTER e normaliza o status', async () => {
    const { fn, chamadas } = fetchFake({ id: 'tpl-123', status: 'PENDING' });
    const api = createMetaTemplateApi({ accessToken: 'tok', wabaId: 'waba-1', fetchFn: fn });
    const r = await api.criar({
      nome: 'aviso_parcela',
      idioma: 'pt_BR',
      categoria: 'utility',
      corpo: 'Olá {{1}}!',
      rodape: 'Resort',
    });
    expect(r).toEqual({ metaId: 'tpl-123', status: 'pendente' });
    expect(chamadas[0]?.url).toContain('/waba-1/message_templates');
    const body = JSON.parse(String(chamadas[0]?.init?.body));
    expect(body.category).toBe('UTILITY');
    expect(body.components[0]).toMatchObject({
      type: 'BODY',
      text: 'Olá {{1}}!',
      example: { body_text: [['exemplo 1']] },
    });
    expect(body.components[1]).toEqual({ type: 'FOOTER', text: 'Resort' });
  });

  it('listar mapeia status da Meta (APPROVED/REJECTED) e motivo de rejeição', async () => {
    const { fn } = fetchFake({
      data: [
        { id: 'a', name: 'ok_tpl', language: 'pt_BR', category: 'UTILITY', status: 'APPROVED' },
        {
          id: 'b',
          name: 'ruim_tpl',
          language: 'pt_BR',
          category: 'MARKETING',
          status: 'REJECTED',
          rejected_reason: 'INVALID_FORMAT',
        },
      ],
    });
    const api = createMetaTemplateApi({ accessToken: 'tok', wabaId: 'waba-1', fetchFn: fn });
    const lista = await api.listar();
    expect(lista[0]).toMatchObject({ nome: 'ok_tpl', status: 'aprovado', categoria: 'utility' });
    expect(lista[1]).toMatchObject({ status: 'rejeitado', motivoRejeicao: 'INVALID_FORMAT' });
  });

  it('erro da Graph API vira exceção com status e corpo', async () => {
    const { fn } = fetchFake({ error: { message: 'nope' } }, 400);
    const api = createMetaTemplateApi({ accessToken: 'tok', wabaId: 'waba-1', fetchFn: fn });
    await expect(api.criar({ nome: 'x_y', corpo: 'oi' })).rejects.toThrow(/Graph API 400/);
  });
});

describe('spec 013 — sendTemplate', () => {
  it('monta o payload de template com parameters e IGNORA a janela de 24h', async () => {
    const { fn, chamadas } = fetchFake({ messages: [{ id: 'wamid.tpl-1' }] });
    const gw = createMetaGateway({ accessToken: 'tok', phoneNumberId: 'fone-1', fetchFn: fn });
    // nenhuma janela é passada — template dispensa (é o meio sancionado de reengajar)
    const r = await gw.sendTemplate({
      to: '5511999990001',
      nome: 'aviso_parcela',
      idioma: 'pt_BR',
      variaveis: ['Renato', 'amanhã'],
    });
    expect(r.waMessageId).toBe('wamid.tpl-1');
    const body = JSON.parse(String(chamadas[0]?.init?.body));
    expect(body.type).toBe('template');
    expect(body.template.name).toBe('aviso_parcela');
    expect(body.template.components[0].parameters).toEqual([
      { type: 'text', text: 'Renato' },
      { type: 'text', text: 'amanhã' },
    ]);
  });

  it('payloadDeTemplate sem variáveis omite components', () => {
    const p = payloadDeTemplate({
      to: '5511999990001',
      nome: 'oi_tpl',
      idioma: 'pt_BR',
      variaveis: [],
    });
    expect((p.template as { components?: unknown }).components).toBeUndefined();
  });
});

describe('spec 043 — botão order_details', () => {
  const PIX = {
    code: '00020101021226820014br.gov.bcb.pix2560pix-h.asaas.com/qr/cobv/abc',
    merchantName: 'SETA TECH LTDA',
    key: 'b1080aa2-3265-4208-b7ec-eb691fb7bdd6',
    keyType: 'EVP' as const,
  };
  const BOTAO = {
    tipo: 'order_details' as const,
    indice: 0,
    orderDetails: {
      referenceId: 'ref-1',
      tipo: 'digital-goods' as const,
      totalCentavos: 114_100,
      taxaCentavos: 0,
      itens: [{ retailerId: '138', nome: 'Parcela 7/100', valorCentavos: 114_100, quantidade: 1 }],
      pix: PIX,
    },
  };

  it('monta o payload que a Meta aceitou na sonda de 15/09/2026', () => {
    const p = payloadDeTemplate({
      to: '5561982248071',
      nome: 'modelo_msg_pagamento_',
      idioma: 'pt_BR',
      variaveis: ['https://sandbox.asaas.com/i/abc'],
      botao: BOTAO,
    });
    const componentes = (p.template as { components: Record<string, unknown>[] }).components;
    expect(componentes[0]).toEqual({
      type: 'body',
      parameters: [{ type: 'text', text: 'https://sandbox.asaas.com/i/abc' }],
    });
    // contrato literal da doc da Meta — não `toMatchObject`
    expect(componentes[1]).toEqual({
      type: 'button',
      sub_type: 'order_details',
      index: 0,
      parameters: [
        {
          type: 'action',
          action: {
            order_details: {
              reference_id: 'ref-1',
              type: 'digital-goods',
              payment_type: 'br',
              payment_settings: [
                {
                  type: 'pix_dynamic_code',
                  pix_dynamic_code: {
                    code: PIX.code,
                    merchant_name: 'SETA TECH LTDA',
                    key: PIX.key,
                    key_type: 'EVP',
                  },
                },
              ],
              currency: 'BRL',
              total_amount: { value: 114_100, offset: 100 },
              order: {
                status: 'pending',
                tax: { value: 0, offset: 100 },
                items: [
                  {
                    retailer_id: '138',
                    name: 'Parcela 7/100',
                    amount: { value: 114_100, offset: 100 },
                    quantity: 1,
                  },
                ],
                subtotal: { value: 114_100, offset: 100 },
              },
            },
          },
        },
      ],
    });
  });

  it('centavos viram {value, offset:100} em todo valor do pedido', () => {
    const p = payloadDeTemplate({
      to: '5561982248071',
      nome: 't',
      idioma: 'pt_BR',
      variaveis: ['x'],
      botao: {
        ...BOTAO,
        orderDetails: {
          ...BOTAO.orderDetails,
          totalCentavos: 50_000,
          itens: [{ retailerId: '1', nome: 'Bolo', valorCentavos: 25_000, quantidade: 2 }],
        },
      },
    });
    const acao = (
      p.template as {
        components: { parameters: { action: { order_details: Record<string, unknown> } }[] }[];
      }
    ).components[1]?.parameters[0]?.action.order_details;
    expect(acao?.total_amount).toEqual({ value: 50_000, offset: 100 });
    expect(acao?.order).toMatchObject({ subtotal: { value: 50_000, offset: 100 } });
  });

  it('botão sem variáveis emite components só com o botão', () => {
    const p = payloadDeTemplate({
      to: '5561982248071',
      nome: 't',
      idioma: 'pt_BR',
      variaveis: [],
      botao: BOTAO,
    });
    const componentes = (p.template as { components: Record<string, unknown>[] }).components;
    expect(componentes).toHaveLength(1);
    expect(componentes[0]).toMatchObject({ type: 'button', sub_type: 'order_details' });
  });

  it('REGRESSÃO 013: sem botão o payload é byte a byte o de antes da 043', () => {
    // comparação de string, não de objeto — é o que prova "byte a byte"
    expect(
      JSON.stringify(
        payloadDeTemplate({ to: '5511999999999', nome: 'aviso', idioma: 'pt_BR', variaveis: [] }),
      ),
    ).toBe(
      '{"messaging_product":"whatsapp","to":"5511999999999","type":"template","template":{"name":"aviso","language":{"code":"pt_BR"}}}',
    );
    expect(
      JSON.stringify(
        payloadDeTemplate({
          to: '5511999999999',
          nome: 'aviso',
          idioma: 'pt_BR',
          variaveis: ['a', 'b'],
        }),
      ),
    ).toBe(
      '{"messaging_product":"whatsapp","to":"5511999999999","type":"template","template":{"name":"aviso","language":{"code":"pt_BR"},"components":[{"type":"body","parameters":[{"type":"text","text":"a"},{"type":"text","text":"b"}]}]}}',
    );
  });

  it('recusa pedido cuja soma dos itens não fecha com o total', () => {
    expect(() => OrderDetailsSchema.parse({ ...BOTAO.orderDetails, totalCentavos: 999 })).toThrow(
      /subtotal/,
    );
  });

  it('recusa key_type fora do enum da Meta', () => {
    expect(() =>
      OrderDetailsSchema.parse({
        ...BOTAO.orderDetails,
        pix: { ...PIX, keyType: 'ALEATORIA' },
      }),
    ).toThrow();
  });
});
