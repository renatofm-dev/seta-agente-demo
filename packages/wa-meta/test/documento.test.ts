import {
  createLogGateway,
  createMetaGateway,
  JanelaFechadaError,
  OutboundDocumentSchema,
} from '@seta/wa-meta';
import { describe, expect, it } from 'vitest';

/**
 * 040 — envio de DOCUMENTO pela Cloud API.
 *
 * A Meta exige dois passos: o arquivo sobe em `/media` e vira `media_id`, e só
 * o id viaja na mensagem. É o caminho que a 040 escolheu em vez de link público
 * assinado — com upload, nenhuma URL nossa serve o boleto, nem por pouco tempo.
 */

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
const ABERTA = { expiraEm: new Date(Date.now() + 3_600_000) };
const FECHADA = { expiraEm: new Date(Date.now() - 1_000) };
const DOC = {
  to: '5511999999999',
  bytes: PDF,
  mime: 'application/pdf',
  filename: 'boleto-parcela-03-20260310.pdf',
  caption: 'Segue a 2ª via da parcela 3/24.',
};

interface Chamada {
  readonly url: string;
  readonly body: unknown;
}

function fakeGraph(opts: { mediaId?: string; falharUpload?: number } = {}) {
  const chamadas: Chamada[] = [];
  const fetchFn: typeof fetch = async (entrada, init) => {
    const url = String(entrada);
    chamadas.push({ url, body: init?.body });
    if (url.endsWith('/media')) {
      if (opts.falharUpload) {
        return new Response('{"error":"too big"}', { status: opts.falharUpload });
      }
      return Response.json({ id: opts.mediaId ?? 'media-123' });
    }
    return Response.json({ messages: [{ id: 'wamid.doc' }] });
  };
  return { fetchFn, chamadas };
}

const gateway = (f: { fetchFn: typeof fetch }) =>
  createMetaGateway({ accessToken: 't', phoneNumberId: '42', fetchFn: f.fetchFn });

describe('sendDocument (040)', () => {
  it('sobe o arquivo e manda só o media_id — os bytes não vão no corpo da mensagem', async () => {
    const f = fakeGraph();
    const r = await gateway(f).sendDocument(DOC, ABERTA);

    expect(r.waMessageId).toBe('wamid.doc');
    expect(f.chamadas).toHaveLength(2);
    expect(f.chamadas[0]?.url).toContain('/42/media');
    expect(f.chamadas[0]?.body).toBeInstanceOf(FormData);

    const msg = JSON.parse(String(f.chamadas[1]?.body)) as Record<string, unknown>;
    expect(f.chamadas[1]?.url).toContain('/42/messages');
    expect(msg.type).toBe('document');
    expect(msg.document).toEqual({
      id: 'media-123',
      filename: DOC.filename,
      caption: DOC.caption,
    });
    // o que mais importa: nenhum byte do boleto no JSON da mensagem
    expect(JSON.stringify(msg)).not.toContain('%PDF');
  });

  it('o multipart leva messaging_product, o tipo e o arquivo com nome', async () => {
    const f = fakeGraph();
    await gateway(f).sendDocument(DOC, ABERTA);
    const form = f.chamadas[0]?.body as FormData;
    expect(form.get('messaging_product')).toBe('whatsapp');
    expect(form.get('type')).toBe('application/pdf');
    const arquivo = form.get('file') as File;
    expect(arquivo.name).toBe(DOC.filename);
    expect(arquivo.size).toBe(PDF.length);
  });

  it('janela fechada nem faz upload — arquivo não fica esquecido na Meta', async () => {
    const f = fakeGraph();
    await expect(gateway(f).sendDocument(DOC, FECHADA)).rejects.toBeInstanceOf(JanelaFechadaError);
    expect(f.chamadas).toHaveLength(0);
  });

  it('falha no upload não vira mensagem enviada', async () => {
    const f = fakeGraph({ falharUpload: 400 });
    await expect(gateway(f).sendDocument(DOC, ABERTA)).rejects.toThrow(/Graph API media 400/);
    expect(f.chamadas).toHaveLength(1);
  });

  it('documento vazio é recusado na validação, antes de qualquer rede', async () => {
    const f = fakeGraph();
    await expect(
      gateway(f).sendDocument({ ...DOC, bytes: new Uint8Array() }, ABERTA),
    ).rejects.toThrow();
    expect(f.chamadas).toHaveLength(0);
  });

  it('caption tem teto de 1024 — menor que o de texto livre', () => {
    expect(OutboundDocumentSchema.safeParse({ ...DOC, caption: 'x'.repeat(1024) }).success).toBe(
      true,
    );
    expect(OutboundDocumentSchema.safeParse({ ...DOC, caption: 'x'.repeat(1025) }).success).toBe(
      false,
    );
  });
});

describe('sendDocument no gateway de log', () => {
  it('loga nome e tamanho, NUNCA os bytes do boleto', async () => {
    const linhas: Record<string, unknown>[] = [];
    const g = createLogGateway({ info: (obj) => linhas.push(obj) });
    const r = await g.sendDocument(DOC, ABERTA);

    expect(r.waMessageId).toMatch(/^sim-doc-/);
    expect(linhas[0]).toMatchObject({ filename: DOC.filename, bytes: PDF.length });
    expect(JSON.stringify(linhas[0])).not.toContain('%PDF');
  });

  it('respeita a janela igual ao gateway real — o modo log não pode divergir', async () => {
    const g = createLogGateway({ info: () => {} });
    await expect(g.sendDocument(DOC, FECHADA)).rejects.toBeInstanceOf(JanelaFechadaError);
  });
});
