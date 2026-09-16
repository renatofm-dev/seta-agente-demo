import { describe, expect, it } from 'vitest';
import {
  criarHttp,
  criarTokenStore,
  ErpAuthError,
  ErpBusinessError,
  ErpUnavailableError,
  erroDeResposta,
  redigir,
} from '../src/index.ts';
import { criarFakeTse } from './fake-tse.ts';

const CONFIG = { baseUrl: 'http://tse.local', username: 'u', password: 'p' };

describe('token', () => {
  it('reaproveita o token entre chamadas — um login, não N', async () => {
    const fake = criarFakeTse();
    fake.responder('GET /api/Lookup/Bancos', { body: [] });
    const { api } = criarHttp({ ...CONFIG, fetchFn: fake.fetchFn });

    await api.request({ method: 'GET', path: '/api/Lookup/Bancos' });
    await api.request({ method: 'GET', path: '/api/Lookup/Bancos' });

    expect(fake.chamadas.filter((c) => c.url.endsWith('/token'))).toHaveLength(1);
  });

  /**
   * O defeito que esta prova evita: no boot, N workers pedem token ao mesmo
   * tempo, o TSE recebe N logins do mesmo operador e pode bloquear a conta.
   */
  it('N chamadas concorrentes compartilham UM refresh', async () => {
    const fake = criarFakeTse();
    const store = criarTokenStore({
      ...CONFIG,
      fetchFn: fake.fetchFn,
      timeoutMs: 1_000,
    });

    const tokens = await Promise.all(Array.from({ length: 8 }, () => store.obter()));

    expect(fake.chamadas.filter((c) => c.url.endsWith('/token'))).toHaveLength(1);
    expect(new Set(tokens).size).toBe(1);
  });

  it('token vencido é renovado sem ninguém pedir', async () => {
    const fake = criarFakeTse({ tokenExpiraEm: 301 }); // 1s de vida útil após a margem
    let relogio = 0;
    const store = criarTokenStore({
      ...CONFIG,
      fetchFn: fake.fetchFn,
      timeoutMs: 1_000,
      agora: () => relogio,
    });

    expect(await store.obter()).toBe('token-1');
    relogio = 5_000;
    expect(await store.obter()).toBe('token-2');
  });

  it('401 no meio do voo: reautentica UMA vez e repete UMA vez', async () => {
    const fake = criarFakeTse();
    let primeira = true;
    const fetchFn: typeof fetch = async (u, init) => {
      const url = String(u);
      if (!url.endsWith('/token') && primeira) {
        primeira = false;
        return new Response(JSON.stringify({ Message: 'Authorization has been denied.' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        });
      }
      return fake.fetchFn(u, init);
    };
    fake.responder('GET /api/Lookup/Bancos', { body: [{ Value: 1 }] });
    const { api } = criarHttp({ ...CONFIG, fetchFn });

    const r = await api.request({ method: 'GET', path: '/api/Lookup/Bancos' });

    expect(r.status).toBe(200);
    expect(fake.chamadas.filter((c) => c.url.endsWith('/token'))).toHaveLength(2);
  });

  it('segundo 401 seguido é credencial errada, não expiração — ErpAuthError', async () => {
    const fake = criarFakeTse();
    const fetchFn: typeof fetch = async (u, init) =>
      String(u).endsWith('/token')
        ? fake.fetchFn(u, init)
        : new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } });
    const { api } = criarHttp({ ...CONFIG, fetchFn });

    await expect(api.request({ method: 'GET', path: '/api/Lookup/Bancos' })).rejects.toBeInstanceOf(
      ErpAuthError,
    );
  });

  it('credencial errada no /token vira ErpAuthError, não erro de negócio', async () => {
    const fetchFn: typeof fetch = async () =>
      new Response(JSON.stringify({ error: 'invalid_grant' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    const store = criarTokenStore({ ...CONFIG, fetchFn, timeoutMs: 1_000 });

    await expect(store.obter()).rejects.toBeInstanceOf(ErpAuthError);
  });
});

describe('retry', () => {
  it('GET re-tenta indisponibilidade com backoff', async () => {
    const fake = criarFakeTse();
    fake.responder('GET /api/Lookup/Bancos', { body: [] });
    fake.derrubar('GET /api/Lookup/Bancos', 2);
    const { api } = criarHttp({ ...CONFIG, fetchFn: fake.fetchFn, esperar: async () => {} });

    const r = await api.request({ method: 'GET', path: '/api/Lookup/Bancos' });

    expect(r.status).toBe(200);
    expect(fake.chamadas.filter((c) => c.url.includes('Bancos'))).toHaveLength(3);
  });

  it('GET desiste depois do limite e sobe ErpUnavailableError', async () => {
    const fake = criarFakeTse();
    fake.responder('GET /api/Lookup/Bancos', { body: [] });
    fake.derrubar('GET /api/Lookup/Bancos', 9);
    const { api } = criarHttp({ ...CONFIG, fetchFn: fake.fetchFn, esperar: async () => {} });

    await expect(api.request({ method: 'GET', path: '/api/Lookup/Bancos' })).rejects.toBeInstanceOf(
      ErpUnavailableError,
    );
  });
});

describe('redação de PII antes do log', () => {
  /**
   * `packages/anonimizacao` cuida do que sai para a LLM. Isto aqui é o outro
   * lado: o corpo do erro do TSE entra na mensagem, e a mensagem vai para o log
   * pino. Nome, CPF, e-mail e linha digitável não podem chegar lá.
   */
  it('nome, CPF, e-mail e linha digitável somem antes de virar mensagem', () => {
    const corpo = JSON.stringify({
      NomePessoa: 'Bruno Ferreira Almeida',
      CpfCnpj: '53022628277',
      Email: 'bruno@exemplo.com.br',
      LinhaDigitavelBoleto: '10495574226900010004500000001875586260000187500',
    });

    const limpo = redigir(corpo);

    expect(limpo).not.toContain('Bruno');
    expect(limpo).not.toContain('53022628277');
    expect(limpo).not.toContain('bruno@exemplo.com.br');
    expect(limpo).not.toContain('10495574226900010004500000001875');
    expect(limpo).toContain('[NOME]');
  });

  it('CPF mascarado também some do texto solto', () => {
    expect(redigir('cpf 530.226.282-77 não confere')).toBe('cpf [CPF] não confere');
  });

  it('a mensagem do erro já sai redigida', () => {
    const e = erroDeResposta('POST /x', 400, '{"NomePessoa":"Fulano de Tal"}');
    expect(e).toBeInstanceOf(ErpBusinessError);
    expect(e.message).not.toContain('Fulano');
  });
});
