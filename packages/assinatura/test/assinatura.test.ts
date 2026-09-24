import { createAssinaturaSimulada, createAutentiqueProvider } from '@seta/assinatura';
import { describe, expect, it } from 'vitest';

/**
 * 046 — os dois lados do port de assinatura.
 *
 * O caso que dá sentido à suíte é o `lerEvento` do Autentique: o corpo usado
 * aqui é o **exemplo de webhook da coleção deles** (`docs/autentique-v2-api.json`),
 * com as chaves achatadas em colchetes. Se um dia o parser deixar de entender
 * aquele corpo, é este teste que avisa — e não a demo na frente do cliente.
 */

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
const SIGNATARIOS = [{ nome: 'Joana Pereira Lima', email: 'joana@exemplo.test' }];

describe('provider simulado', () => {
  const simulado = (baseUrl: string) =>
    createAssinaturaSimulada({ baseUrl, novoId: () => 'abc123' });

  it('devolve um link por signatário, apontando para a página do nosso server', async () => {
    const r = await simulado('https://tunel.test').criarDocumento({
      nome: 'Contrato 10123',
      pdf: PDF,
      signatarios: [{ nome: 'Joana' }, { nome: 'Carlos' }],
    });

    expect(r.id).toBe('abc123');
    expect(r.links).toEqual([
      { signatario: 'Joana', url: 'https://tunel.test/assinar/abc123' },
      { signatario: 'Carlos', url: 'https://tunel.test/assinar/abc123' },
    ]);
  });

  it('barra final na base não vira barra dupla no link', async () => {
    const r = await simulado('https://tunel.test/').criarDocumento({
      nome: 'Contrato 1',
      pdf: PDF,
      signatarios: SIGNATARIOS,
    });
    expect(r.links[0]?.url).toBe('https://tunel.test/assinar/abc123');
  });

  it('documento sem bytes ou sem signatário não vira link', async () => {
    const p = simulado('https://tunel.test');
    await expect(
      p.criarDocumento({ nome: 'x', pdf: new Uint8Array(), signatarios: SIGNATARIOS }),
    ).rejects.toThrow(/sem bytes/);
    await expect(p.criarDocumento({ nome: 'x', pdf: PDF, signatarios: [] })).rejects.toThrow(
      /sem signat/,
    );
  });

  it('lê o evento da própria página e ignora corpo estranho', () => {
    const p = simulado('https://tunel.test');
    expect(
      p.lerEvento({ documento: 'abc123', estado: 'assinada', assinado_em: '2026-09-24T12:00:00Z' }),
    ).toEqual({
      idDocumento: 'abc123',
      estado: 'assinada',
      assinadoEm: '2026-09-24T12:00:00Z',
      urlAssinado: null,
    });
    expect(p.lerEvento({ qualquer: 'coisa' })).toBeNull();
    expect(p.lerEvento('não é objeto')).toBeNull();
  });
});

describe('provider Autentique', () => {
  function fake(resposta: unknown, ok = true) {
    const chamadas: { url: string; init?: RequestInit }[] = [];
    const fetchFn: typeof fetch = async (entrada, init) => {
      chamadas.push({ url: String(entrada), init });
      return ok ? Response.json(resposta) : new Response(JSON.stringify(resposta), { status: 401 });
    };
    return {
      chamadas,
      provider: createAutentiqueProvider({ accessToken: 'tok', fetchFn }),
    };
  }

  it('monta o multipart do GraphQL e devolve o short_link de cada signatário', async () => {
    const { provider, chamadas } = fake({
      data: {
        createDocument: {
          id: 'doc-uuid',
          signatures: [
            { name: 'Joana Pereira Lima', link: { short_link: 'https://autentique.test/s/xyz' } },
          ],
        },
      },
    });

    const r = await provider.criarDocumento({
      nome: 'Contrato 10123',
      pdf: PDF,
      signatarios: SIGNATARIOS,
    });

    expect(r).toEqual({
      id: 'doc-uuid',
      links: [{ signatario: 'Joana Pereira Lima', url: 'https://autentique.test/s/xyz' }],
    });
    expect(chamadas[0]?.url).toBe('https://api.autentique.com.br/v2/graphql');
    const form = chamadas[0]?.init?.body as FormData;
    expect(String(form.get('map'))).toBe('{"file":["variables.file"]}');
    expect(String(form.get('operations'))).toContain('createDocument');
    expect(form.get('file')).toBeInstanceOf(Blob);
  });

  it('200 com `errors` é falha — GraphQL não usa status para isso', async () => {
    const { provider } = fake({ errors: [{ message: 'token inválido' }] });

    await expect(
      provider.criarDocumento({ nome: 'c', pdf: PDF, signatarios: SIGNATARIOS }),
    ).rejects.toThrow(/token inválido/);
  });

  it('lê o webhook REAL da coleção deles: assinado, com a via assinada', () => {
    const { provider } = fake({});

    const evento = provider.lerEvento({
      'partes[0][uuid]': '2f664427ff5711ea8f0742010a9e0014',
      'partes[0][nome]': 'João Teste',
      'partes[0][assinado][created]': '2020-09-25 14:49:49',
      'partes[0][assinado][ipv4]': '179.233.14.136',
      'documento[uuid]': '8d927bd405668cdf952abe0c3994bbce7b26cdb7302c49774',
      'documento[nome]': 'Documento Teste',
      'arquivo[assinado]':
        'https://api.autentique.com.br/documentos/8d927bd405668cdf952abe0c3994bbce7b26cdb7302c49774/assinado.pdf',
    });

    expect(evento).toEqual({
      idDocumento: '8d927bd405668cdf952abe0c3994bbce7b26cdb7302c49774',
      estado: 'assinada',
      assinadoEm: '2020-09-25 14:49:49',
      urlAssinado:
        'https://api.autentique.com.br/documentos/8d927bd405668cdf952abe0c3994bbce7b26cdb7302c49774/assinado.pdf',
    });
  });

  it('sem assinatura ainda, o evento é pendente — e corpo sem documento é ignorado', () => {
    const { provider } = fake({});

    expect(provider.lerEvento({ 'documento[uuid]': 'doc-1' })).toMatchObject({
      estado: 'pendente',
      assinadoEm: null,
    });
    expect(provider.lerEvento({ 'partes[0][nome]': 'sem documento' })).toBeNull();
  });
});
