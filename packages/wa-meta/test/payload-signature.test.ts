import {
  createLogGateway,
  createMetaGateway,
  JanelaFechadaError,
  parseInboundTexts,
  parseStatuses,
  signBody,
  verifySignature,
  WebhookPayloadSchema,
} from '@seta/wa-meta';
import { describe, expect, it } from 'vitest';

const PAYLOAD_META = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: '102290129340398',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            messages: [
              {
                from: '5511999990001',
                id: 'wamid.HBgLNTUxMTk5OTk5MDAwMRUCABIYFjNFQjBEMUE=',
                timestamp: '1756246000',
                type: 'text',
                text: { body: 'quais boletos tenho em aberto?' },
              },
              {
                from: '5511999990001',
                id: 'wamid.imagem123',
                timestamp: '1756246001',
                type: 'image',
              },
            ],
          },
        },
      ],
    },
  ],
};

describe('payload da Meta', () => {
  it('extrai só mensagens de texto, com timestamp convertido', () => {
    const payload = WebhookPayloadSchema.parse(PAYLOAD_META);
    const msgs = parseInboundTexts(payload);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({
      waId: '5511999990001',
      texto: 'quais boletos tenho em aberto?',
    });
    expect(msgs[0]?.timestamp.getTime()).toBe(1756246000 * 1000);
  });

  it('extrai statuses de entrega', () => {
    const payload = WebhookPayloadSchema.parse({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [{ value: { statuses: [{ id: 'wamid.out1', status: 'delivered' }] } }],
        },
      ],
    });
    expect(parseStatuses(payload)).toEqual([{ waMessageId: 'wamid.out1', status: 'delivered' }]);
  });
});

describe('assinatura X-Hub-Signature-256', () => {
  const corpo = JSON.stringify(PAYLOAD_META);
  const secret = 'segredo-teste';

  it('aceita assinatura correta', () => {
    expect(verifySignature(corpo, secret, signBody(corpo, secret))).toBe(true);
  });

  it('rejeita assinatura errada, corpo adulterado e header malformado', () => {
    expect(verifySignature(corpo, secret, signBody(corpo, 'outro-secret'))).toBe(false);
    expect(verifySignature(`${corpo} `, secret, signBody(corpo, secret))).toBe(false);
    expect(verifySignature(corpo, secret, undefined)).toBe(false);
    expect(verifySignature(corpo, secret, 'sha1=abc')).toBe(false);
    expect(verifySignature(corpo, secret, 'sha256=curta')).toBe(false);
  });
});

describe('OutboundGateway', () => {
  const janelaAberta = { expiraEm: new Date(Date.now() + 3_600_000) };
  const janelaFechada = { expiraEm: new Date(Date.now() - 1_000) };

  it('janela fechada (ou nunca aberta) falha explícito nos dois gateways', async () => {
    const log = createLogGateway({ info: () => {} });
    await expect(log.send({ to: '5511999990001', body: 'oi' }, janelaFechada)).rejects.toThrow(
      JanelaFechadaError,
    );
    await expect(log.send({ to: '5511999990001', body: 'oi' }, { expiraEm: null })).rejects.toThrow(
      JanelaFechadaError,
    );
    const meta = createMetaGateway({
      accessToken: 't',
      phoneNumberId: '1',
      fetchFn: () => {
        throw new Error('não deveria chamar a API');
      },
    });
    await expect(meta.send({ to: '5511999990001', body: 'oi' }, janelaFechada)).rejects.toThrow(
      JanelaFechadaError,
    );
  });

  it('gateway meta monta a request da Graph API e retorna o wamid', async () => {
    const chamadas: { url: string; init: RequestInit }[] = [];
    const fetchFake = (async (url: string | URL | Request, init?: RequestInit) => {
      chamadas.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ messages: [{ id: 'wamid.novo' }] }), { status: 200 });
    }) as typeof fetch;

    const meta = createMetaGateway({
      accessToken: 'tok',
      phoneNumberId: '555',
      fetchFn: fetchFake,
    });
    const r = await meta.send({ to: '5511999990001', body: 'olá!' }, janelaAberta);
    expect(r.waMessageId).toBe('wamid.novo');
    expect(chamadas[0]?.url).toBe('https://graph.facebook.com/v21.0/555/messages');
    const body = JSON.parse(String(chamadas[0]?.init.body));
    expect(body).toMatchObject({ messaging_product: 'whatsapp', to: '5511999990001' });
    const headers = chamadas[0]?.init.headers as Record<string, string> | undefined;
    expect(headers?.authorization).toBe('Bearer tok');
  });

  it('gateway log valida payload e gera wamid sintético', async () => {
    const eventos: Record<string, unknown>[] = [];
    const log = createLogGateway({ info: (o) => eventos.push(o) });
    const r = await log.send({ to: '5511999990001', body: 'olá' }, janelaAberta);
    expect(r.waMessageId).toMatch(/^sim-/);
    expect(eventos[0]).toMatchObject({ to: '5511999990001' });
    await expect(log.send({ to: 'inválido', body: 'x' }, janelaAberta)).rejects.toThrow();
  });
});
