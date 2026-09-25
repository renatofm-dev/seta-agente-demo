import { createMetaGateway } from '@seta/wa-meta';
import { describe, expect, it } from 'vitest';

/**
 * O link de pagamento (014/042) chegava no WhatsApp como texto morto: aparecia
 * na conversa e não abria nada ao toque. A causa não estava no PSP — a URL do
 * Asaas respondia 200 — e sim no payload: sem `preview_url`, o Cloud API manda
 * a URL como texto comum, sem cartão de preview e sem link clicável.
 */

const ABERTA = { expiraEm: new Date(Date.now() + 3_600_000) };

function fakeGraph() {
  const enviados: Record<string, unknown>[] = [];
  const fetchFn: typeof fetch = async (_entrada, init) => {
    enviados.push(JSON.parse(String(init?.body)));
    return Response.json({ messages: [{ id: 'wamid.txt' }] });
  };
  return {
    enviados,
    gateway: createMetaGateway({ accessToken: 't', phoneNumberId: '42', fetchFn }),
  };
}

describe('send: URL no corpo (014)', () => {
  it('texto com link pede preview — é o que torna o link clicável', async () => {
    const { enviados, gateway } = fakeGraph();

    await gateway.send(
      {
        to: '5511999999999',
        body: 'Seu link de pagamento está pronto!\nhttps://sandbox.asaas.com/i/abc\nPágina segura.',
      },
      ABERTA,
    );

    expect(enviados[0]?.text).toMatchObject({ preview_url: true });
  });

  it('texto sem link não pede preview — nada para prever', async () => {
    const { enviados, gateway } = fakeGraph();

    await gateway.send({ to: '5511999999999', body: 'Seu contrato está em dia 🙂' }, ABERTA);

    expect(enviados[0]?.text).toMatchObject({ preview_url: false });
  });

  it('http sem s também conta — o que importa é o que o cliente toca', async () => {
    const { enviados, gateway } = fakeGraph();

    await gateway.send({ to: '5511999999999', body: 'veja em http://exemplo.test/x' }, ABERTA);

    expect(enviados[0]?.text).toMatchObject({ preview_url: true });
  });
});
