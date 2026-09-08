import {
  createMetaGateway,
  createMetaTemplateApi,
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
