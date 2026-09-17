import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * TSE de mentira em cima de `fetch`, alimentado pelas FIXTURES da 035 — os
 * exemplos de resposta reais do fornecedor. Testar contra eles é o que dá
 * sentido a "o adapter entende o que o TSE responde", sem rede e sem Postgres.
 */

const FIXTURES = join(import.meta.dirname, '../../../apps/tse-sim/contrato/fixtures');

export function fixture(nome: string): { body: unknown; contentType: string } {
  const f = JSON.parse(readFileSync(join(FIXTURES, `${nome}.json`), 'utf-8')) as {
    body: unknown;
    contentType: string;
  };
  return f;
}

export interface Chamada {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

export interface FakeTse {
  readonly fetchFn: typeof fetch;
  readonly chamadas: readonly Chamada[];
  /** Registra a resposta de uma rota: `'POST /api/financeiro/TransacaoEletronica'`. */
  responder(rota: string, r: { status?: number; body: unknown }): void;
  /** Faz a próxima chamada a essa rota explodir (rede/timeout). */
  derrubar(rota: string, vezes?: number): void;
  /** 040: resposta BINÁRIA — `SegundaViaBoleto` devolve PDF, não JSON. */
  responderBytes(
    rota: string,
    r: { status?: number; bytes: Uint8Array; contentType?: string },
  ): void;
}

export function criarFakeTse(opts: { tokenExpiraEm?: number } = {}): FakeTse {
  const chamadas: Chamada[] = [];
  const respostas = new Map<string, { status: number; body: unknown }>();
  const binarias = new Map<string, { status: number; bytes: Uint8Array; contentType: string }>();
  const quedas = new Map<string, number>();
  let emitidos = 0;

  const fetchFn: typeof fetch = async (entrada, init) => {
    const url =
      typeof entrada === 'string' ? entrada : ((entrada as Request).url ?? String(entrada));
    const method = (init?.method ?? 'GET').toUpperCase();
    const caminho = new URL(url).pathname;
    const rota = `${method} ${caminho}`;
    const corpo = init?.body;
    chamadas.push({
      method,
      url,
      body: typeof corpo === 'string' && corpo.startsWith('{') ? JSON.parse(corpo) : corpo,
    });

    const restam = quedas.get(rota) ?? 0;
    if (restam > 0) {
      quedas.set(rota, restam - 1);
      throw new TypeError('fetch failed');
    }

    if (rota === 'POST /token') {
      emitidos += 1;
      return Response.json({
        access_token: `token-${emitidos}`,
        token_type: 'bearer',
        expires_in: opts.tokenExpiraEm ?? 86_399,
        userName: 'integracao',
        userId: '1',
      });
    }

    const bin = binarias.get(rota);
    if (bin) {
      return new Response(bin.bytes, {
        status: bin.status,
        headers: { 'content-type': bin.contentType },
      });
    }

    const r = respostas.get(rota);
    if (!r) return new Response('sem stub', { status: 404 });
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  };

  return {
    fetchFn,
    chamadas,
    responder(rota, r) {
      respostas.set(rota, { status: r.status ?? 200, body: r.body });
    },
    derrubar(rota, vezes = 1) {
      quedas.set(rota, vezes);
    },
    responderBytes(rota, r) {
      binarias.set(rota, {
        status: r.status ?? 200,
        bytes: r.bytes,
        contentType: r.contentType ?? 'application/pdf',
      });
    },
  };
}
