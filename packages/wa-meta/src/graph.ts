/**
 * O pedaço do POST em `/<phone_number_id>/messages` que NÃO deve existir em duas
 * versões: URL, headers e o erro de HTTP.
 *
 * O corpo da resposta fica de fora de propósito. O MESMO endpoint responde
 * `{messages:[{id}]}` para um envio e `{success:true}` para o indicador de
 * digitação — quem sabe qual dos dois esperar é o chamador, e colapsar as duas
 * leituras aqui faria um sucesso virar erro do outro lado.
 */

/** Versão da Graph API usada quando o chamador não escolhe uma. */
export const GRAPH_VERSAO_DEFAULT = 'v21.0';

/** Credenciais e alvo de qualquer chamada ao `/messages` de um número. */
export interface GraphMessagesConfig {
  readonly accessToken: string;
  readonly phoneNumberId: string;
  readonly graphVersion?: string;
  /** Injetado nos testes — não há nock/msw no repo, a dublagem é sempre aqui. */
  readonly fetchFn?: typeof fetch;
}

/**
 * `timeoutMs` ausente ⇒ sem timeout, que é o comportamento do ENVIO: quem manda
 * mensagem tem retry no outbox e não pode desistir sozinho de um socket lento.
 * Quem usa o timeout é o indicador de digitação, que é enfeite com prazo de 25 s
 * e não pode deixar request pendurada pelo resto do turno.
 */
export function criarPostMessages(
  config: GraphMessagesConfig,
  opts: { readonly timeoutMs?: number } = {},
): (payload: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown> {
  const fetchFn = config.fetchFn ?? fetch;
  const versao = config.graphVersion ?? GRAPH_VERSAO_DEFAULT;
  return async (payload, signal) => {
    /**
     * Dois motivos para desistir, e os dois valem: o timeout do adapter e o
     * cancelamento de quem chamou. `AbortSignal.any` é o que permite um sem
     * perder o outro — e o signal do chamador é o que faz o indicador de
     * digitação parar de sair quando a resposta já foi enfileirada.
     */
    const sinais = [
      ...(opts.timeoutMs === undefined ? [] : [AbortSignal.timeout(opts.timeoutMs)]),
      ...(signal ? [signal] : []),
    ];
    const res = await fetchFn(
      `https://graph.facebook.com/${versao}/${config.phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
        ...(sinais.length === 0 ? {} : { signal: AbortSignal.any(sinais) }),
      },
    );
    if (!res.ok) {
      throw new Error(`Graph API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    return await res.json();
  };
}
