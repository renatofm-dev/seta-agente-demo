import type {
  AssinaturaCriada,
  AssinaturaProvider,
  DocumentoParaAssinar,
  EventoAssinatura,
} from './tipos.js';

/**
 * Autentique v2 — a implementação real, atrás do mesmo port do dublê.
 *
 * A API é **GraphQL num endpoint só** (`POST /v2/graphql`), com Bearer. Criar
 * documento é `multipart/form-data` no formato do GraphQL multipart request:
 * `operations` com a query e as variáveis (o arquivo entra como `null`), `map`
 * dizendo qual parte do form preenche qual variável, e a parte com os bytes.
 * A resposta traz `signatures[].link.short_link` — o link por signatário, que é
 * o que vai para o WhatsApp.
 *
 * O webhook deles é **form-urlencoded** e chega achatado em chaves com
 * colchetes (`partes[0][assinado][created]`, `arquivo[assinado]`). É disso que
 * `lerEvento` extrai o que interessa: assinaram? quando? onde está a via
 * assinada?
 *
 * Referência versionada em `docs/autentique-v2-api.json`. **Nunca foi exercida
 * contra a API real** — a demo roda no dublê, por decisão da 046 (o webhook do
 * Autentique registra CPF, nascimento, IP e cidade de quem assina, e uma
 * demonstração não pode criar registro de assinatura real de quem só assiste).
 */

const MUTATION_CRIAR = `mutation CreateDocumentMutation($document: DocumentInput!, $signers: [SignerInput!]!, $file: Upload!) {
  createDocument(document: $document, signers: $signers, file: $file) {
    id
    name
    signatures { public_id name email link { short_link } }
  }
}`;

export interface AutentiqueConfig {
  readonly accessToken: string;
  readonly baseUrl?: string;
  readonly fetchFn?: typeof fetch;
}

interface RespostaCriar {
  readonly data?: {
    readonly createDocument?: {
      readonly id?: string;
      readonly signatures?: readonly {
        readonly name?: string | null;
        readonly link?: { readonly short_link?: string | null } | null;
      }[];
    };
  };
  readonly errors?: readonly { readonly message?: string }[];
}

/** O webhook chega achatado: `partes[0][assinado][created]`, `arquivo[assinado]`. */
function campo(corpo: Record<string, unknown>, chave: string): string | null {
  const v = corpo[chave];
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

export function createAutentiqueProvider(config: AutentiqueConfig): AssinaturaProvider {
  const fetchFn = config.fetchFn ?? fetch;
  const url = config.baseUrl ?? 'https://api.autentique.com.br/v2/graphql';

  return {
    nome: 'autentique',

    async criarDocumento(d: DocumentoParaAssinar): Promise<AssinaturaCriada> {
      const operations = JSON.stringify({
        query: MUTATION_CRIAR,
        variables: {
          document: { name: d.nome },
          signers: d.signatarios.map((s) => ({ email: s.email, action: 'SIGN' })),
          file: null,
        },
      });

      const form = new FormData();
      form.append('operations', operations);
      form.append('map', JSON.stringify({ file: ['variables.file'] }));
      // cópia do buffer: `Blob` não aceita view com offset sem levar o buffer inteiro
      form.append(
        'file',
        new Blob([new Uint8Array(d.pdf)], { type: 'application/pdf' }),
        `${d.nome}.pdf`,
      );

      const res = await fetchFn(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${config.accessToken}` },
        body: form,
      });
      if (!res.ok) {
        throw new Error(`Autentique ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      const corpo = (await res.json()) as RespostaCriar;
      // GraphQL responde 200 com `errors` — 200 não é sinônimo de sucesso,
      // a mesma armadilha do `SetVenda` do TSE
      if (corpo.errors?.length) {
        throw new Error(`Autentique: ${corpo.errors.map((e) => e.message).join('; ')}`);
      }
      const doc = corpo.data?.createDocument;
      if (!doc?.id) throw new Error('Autentique: resposta sem id de documento');

      return {
        id: doc.id,
        links: (doc.signatures ?? [])
          .filter((s) => typeof s.link?.short_link === 'string')
          .map((s) => ({
            signatario: s.name ?? '',
            url: s.link?.short_link ?? '',
          })),
      };
    },

    lerEvento(corpo: unknown): EventoAssinatura | null {
      if (typeof corpo !== 'object' || corpo === null) return null;
      const dados = corpo as Record<string, unknown>;
      const idDocumento = campo(dados, 'documento[uuid]');
      if (!idDocumento) return null;

      const assinadoEm = campo(dados, 'partes[0][assinado][created]');
      const rejeitado = campo(dados, 'partes[0][rejeitado][created]');
      return {
        idDocumento,
        estado: assinadoEm ? 'assinada' : rejeitado ? 'recusada' : 'pendente',
        assinadoEm,
        urlAssinado: campo(dados, 'arquivo[assinado]'),
      };
    },
  };
}
