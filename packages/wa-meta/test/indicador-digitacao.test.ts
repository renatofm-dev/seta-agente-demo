import {
  createLogIndicador,
  createMetaIndicador,
  ehWamidDaMeta,
  type IndicadorDigitacao,
} from '@seta/wa-meta';
import { describe, expect, it } from 'vitest';

/**
 * Indicador de digitação da Cloud API.
 *
 * O contrato é estreito e cheio de armadilha: é um POST no MESMO `/messages` do
 * envio, mas com `status: 'read'` — e a resposta é `{success:true}`, sem
 * `messages[0].id`. Um campo a mais no corpo é 400 da Graph API que, sendo este
 * efeito best-effort (o chamador engole e loga), ninguém veria.
 */

interface Chamada {
  readonly url: string;
  readonly headers: unknown;
  readonly body: unknown;
  readonly signal: AbortSignal | null | undefined;
}

function fakeGraph(status = 200, corpo: unknown = { success: true }) {
  const chamadas: Chamada[] = [];
  const fetchFn: typeof fetch = async (entrada, init) => {
    // honra o signal como o fetch real: sem isto o dublê mentiria justamente
    // sobre o cancelamento, que é o que este arquivo precisa provar
    if (init?.signal?.aborted) throw new DOMException('This operation was aborted', 'AbortError');
    chamadas.push({
      url: String(entrada),
      headers: init?.headers,
      body: init?.body,
      signal: init?.signal,
    });
    if (status !== 200)
      return new Response('{"error":{"message":"invalid message_id"}}', { status });
    return Response.json(corpo);
  };
  return { fetchFn, chamadas };
}

const WAMID = 'wamid.HBgNNTU5NDc1ODE4MDIVAgAS';

const indicador = (f: { fetchFn: typeof fetch }, graphVersion?: string): IndicadorDigitacao =>
  createMetaIndicador({
    accessToken: 'tok',
    phoneNumberId: '555',
    fetchFn: f.fetchFn,
    ...(graphVersion ? { graphVersion } : {}),
  });

describe('createMetaIndicador', () => {
  it('manda exatamente o corpo que a Meta espera — nem um campo a mais', async () => {
    const f = fakeGraph();
    await indicador(f).mostrar(WAMID);

    expect(f.chamadas).toHaveLength(1);
    // toEqual, não toMatchObject: campo extra aqui é 400 silencioso
    expect(JSON.parse(String(f.chamadas[0]?.body))).toEqual({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: WAMID,
      typing_indicator: { type: 'text' },
    });
  });

  it('usa o /messages do número, com o bearer do token', async () => {
    const f = fakeGraph();
    await indicador(f).mostrar(WAMID);

    expect(f.chamadas[0]?.url).toBe('https://graph.facebook.com/v21.0/555/messages');
    expect(f.chamadas[0]?.headers).toMatchObject({ authorization: 'Bearer tok' });
  });

  it('respeita a versão da Graph API escolhida', async () => {
    const f = fakeGraph();
    await indicador(f, 'v23.0').mostrar(WAMID);

    expect(f.chamadas[0]?.url).toBe('https://graph.facebook.com/v23.0/555/messages');
  });

  it('trata {success:true} como sucesso — a resposta não tem message id, e não deve ter', async () => {
    const f = fakeGraph();

    // regressão: reusar o postMessages do gateway faria TODO disparo
    // bem-sucedido lançar 'Graph API sem message id na resposta'
    await expect(indicador(f).mostrar(WAMID)).resolves.toBeUndefined();
  });

  it('erro da Graph API chega ao chamador — o adapter reporta, não esconde', async () => {
    const f = fakeGraph(400);

    await expect(indicador(f).mostrar(WAMID)).rejects.toThrow(/Graph API 400/);
  });

  it('wamid vazio é recusado antes de qualquer rede', async () => {
    const f = fakeGraph();

    await expect(indicador(f).mostrar('')).rejects.toThrow();
    expect(f.chamadas).toHaveLength(0);
  });

  it('id sintético do simulador não vai para a Meta', async () => {
    const f = fakeGraph();

    // `pnpm dev-whatsapp` roda simulador e número real no MESMO processo; sem
    // isto, cada turno simulado viraria um 400 e um warn sobre nada
    await expect(indicador(f).mostrar('sim-0199-abc')).resolves.toBeUndefined();
    expect(f.chamadas).toHaveLength(0);
  });

  it('signal abortado cancela o disparo em vôo — é assim que a resposta o cala', async () => {
    const f = fakeGraph();
    const abortar = new AbortController();
    abortar.abort();

    // sem isto, um request que pousa na Meta DEPOIS do envio acende o indicador
    // com a mensagem já entregue, e nada o apaga pelos 25 s seguintes
    await expect(indicador(f).mostrar(WAMID, abortar.signal)).rejects.toThrow(/abort/i);
    expect(f.chamadas).toHaveLength(0);
  });

  it('sem cancelamento, o signal do timeout ainda chega ao fetch', async () => {
    const f = fakeGraph();
    await indicador(f).mostrar(WAMID);

    // o timeout de 3 s do adapter não pode sumir quando o chamador não cancela
    expect(f.chamadas[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('ehWamidDaMeta separa o id da Meta do id do simulador', () => {
    expect(ehWamidDaMeta(WAMID)).toBe(true);
    expect(ehWamidDaMeta('sim-0199-abc')).toBe(false);
  });
});

describe('createLogIndicador', () => {
  it('loga o wamid e não falha', async () => {
    const linhas: { obj: Record<string, unknown>; msg: string }[] = [];
    const ind = createLogIndicador({ info: (obj, msg) => linhas.push({ obj, msg }) });

    await expect(ind.mostrar(WAMID)).resolves.toBeUndefined();
    expect(linhas).toHaveLength(1);
    expect(linhas[0]?.obj).toMatchObject({ waMessageId: WAMID });
  });

  it('recusa wamid vazio igual ao real — o modo log não pode divergir', async () => {
    const ind = createLogIndicador({ info: () => {} });

    await expect(ind.mostrar('')).rejects.toThrow();
  });
});
