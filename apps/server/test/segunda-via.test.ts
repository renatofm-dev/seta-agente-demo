import type { Executor, SessionCtx } from '@seta/query-catalog';
import { describe, expect, it } from 'vitest';
import {
  nomeDoArquivo,
  type PedidoSegundaVia,
  toolEnviarSegundaVia,
} from '../src/wa/segunda-via.ts';

/**
 * 040 — o nome do arquivo que o cotista vê no WhatsApp.
 *
 * O caso que dá nome a esta suíte: `vencimento` chega do `pg` como **Date**,
 * não como string ISO. Tratar como string produzia `boleto-parcela-100-17.pdf`
 * — nome sem sentido e, pior, o mesmo erro na legenda da mensagem. `isoDia`
 * (014) normaliza as duas formas sem deslocar o dia por fuso.
 */
describe('nomeDoArquivo (040)', () => {
  it('aceita o Date que o pg devolve, sem deslocar o dia', () => {
    expect(nomeDoArquivo(3, new Date(2026, 2, 10))).toBe('boleto-parcela-03-20260310.pdf');
  });

  it('aceita string ISO também — o catálogo pode devolver qualquer uma das duas', () => {
    expect(nomeDoArquivo(3, '2026-03-10')).toBe('boleto-parcela-03-20260310.pdf');
  });

  it('parcela de três dígitos não é truncada', () => {
    expect(nomeDoArquivo(100, '2026-03-10')).toBe('boleto-parcela-100-20260310.pdf');
  });

  it('sem vencimento utilizável, o nome ainda é válido', () => {
    expect(nomeDoArquivo(7, null)).toBe('boleto-parcela-07.pdf');
    expect(nomeDoArquivo(7, 'sei lá')).toBe('boleto-parcela-07.pdf');
  });

  it('só [a-z0-9-] no nome — ele atravessa multipart e aparece na tela do cotista', () => {
    expect(nomeDoArquivo('3/24', '2026-03-10')).toMatch(/^[a-z0-9-]+\.pdf$/);
  });
});

/**
 * O parâmetro da tool é o NÚMERO da parcela, não o id da linha — foi assim que
 * a 040 parou de mandar o boleto errado: o modelo lia "parcela 20" na listagem
 * e mandava `20` como id, que no banco é outra parcela, de outro vencimento.
 * Aqui só interessa o que a tool faz com o que a consulta devolve; quem prova
 * o caminho inteiro é `segunda-via.integration.test.ts`.
 */
describe('enviar_segunda_via: do número para a linha (040)', () => {
  const session: SessionCtx = { traceId: 't', clienteId: '10002' };
  const linha = {
    id: '77',
    parcela: 20,
    total_parcelas: 120,
    valor_centavos: 193500,
    vencimento: '2026-10-09',
    origem: 'saldo',
    meio_pagamento: 'boleto',
    linha_digitavel: '23790001',
    status: 'aberto',
  };
  const tool = (rows: readonly Record<string, unknown>[], registrar = () => {}) => {
    const chamadas: { id: string; params: Record<string, unknown> }[] = [];
    const executor: Executor = {
      async run(id, params) {
        chamadas.push({ id, params });
        return { rows, rowCount: rows.length, truncated: false };
      },
    };
    return { spec: toolEnviarSegundaVia({ executor, session }, registrar), chamadas };
  };

  it('manda o número para a consulta — o id nunca vem do modelo', async () => {
    const pedidos: PedidoSegundaVia[] = [];
    const { spec, chamadas } = tool([linha], (p) => pedidos.push(p));

    const r = await spec.execute({ parcela: '20' }, session);

    expect(chamadas).toEqual([{ id: 'financeiro.parcela_por_numero', params: { parcela: '20' } }]);
    expect(r.rows[0]).toMatchObject({ ok: true, parcela: 'parcela 20/120' });
    // o id de VERDADE, o que veio da consulta, é o que o servidor vai buscar
    expect(pedidos[0]?.anexo.contaFinanceiraId).toBe('77');
    expect(pedidos[0]?.anexo.filename).toBe('boleto-parcela-20-20261009.pdf');
  });

  it('número que o cotista fala como inteiro também vale', async () => {
    const { spec, chamadas } = tool([linha]);
    await spec.execute({ parcela: 20 }, session);
    expect(chamadas[0]?.params).toEqual({ parcela: '20' });
  });

  it('duas parcelas com o mesmo número: pergunta, não escolhe', async () => {
    const pedidos: PedidoSegundaVia[] = [];
    const outra = { ...linha, id: '78', origem: 'entrada', vencimento: '2026-11-08' };
    const { spec } = tool([linha, outra], (p) => pedidos.push(p));

    const r = await spec.execute({ parcela: '20' }, session);

    expect(r.rows[0]).toMatchObject({ ok: false });
    expect(String(r.rows[0]?.motivo)).toMatch(/pergunte ao cliente qual delas/);
    expect(r.rows[0]?.opcoes).toHaveLength(2);
    // nada foi registrado: ninguém recebe boleto de uma escolha que não foi feita
    expect(pedidos).toHaveLength(0);
  });

  it('número que não existe no contrato volta ok=false, sem aproximação', async () => {
    const pedidos: PedidoSegundaVia[] = [];
    const { spec } = tool([], (p) => pedidos.push(p));

    const r = await spec.execute({ parcela: '999' }, session);

    expect(r.rows[0]).toMatchObject({ ok: false });
    expect(String(r.rows[0]?.motivo)).toMatch(/não achei a parcela 999/);
    expect(pedidos).toHaveLength(0);
  });
});

/**
 * #36 — a parcela também se aponta pelo MÊS.
 *
 * O número só serve quando o cotista o tem à mão. Num contrato de 88 ou 120
 * parcelas ele não tem: a conversa mostra uma janela de 5 (`proximas_parcelas`)
 * e as vencidas. Em campo, o pedido foi "o pdf da última parcela que tenho em
 * aberto" e o agente respondeu com a 24 — a última das cinco que ele enxergava,
 * quando a última de verdade era a 120.
 *
 * "A parcela de março" é como ele fala, e é o critério de aceite da própria 040.
 */
describe('enviar_segunda_via: apontar pelo mês (#36)', () => {
  const session: SessionCtx = { traceId: 't', clienteId: '10159' };
  const linha = {
    id: '5328',
    parcela: 33,
    total_parcelas: 88,
    valor_centavos: 210700,
    vencimento: '2027-03-26',
    origem: 'saldo',
    meio_pagamento: 'boleto',
    linha_digitavel: '46191110',
    status: 'aberto',
  };
  const tool = (rows: readonly Record<string, unknown>[], registrar = () => {}) => {
    const chamadas: { id: string; params: Record<string, unknown> }[] = [];
    const executor: Executor = {
      async run(id, params) {
        chamadas.push({ id, params });
        return { rows, rowCount: rows.length, truncated: false };
      },
    };
    return { spec: toolEnviarSegundaVia({ executor, session }, registrar), chamadas };
  };

  it('o mês vai para a consulta por mês — e o id continua vindo do servidor', async () => {
    const pedidos: PedidoSegundaVia[] = [];
    const { spec, chamadas } = tool([linha], (p) => pedidos.push(p));

    const r = await spec.execute({ mes: '2027-03' }, session);

    expect(chamadas).toEqual([{ id: 'financeiro.parcela_por_mes', params: { mes: '2027-03' } }]);
    expect(r.rows[0]).toMatchObject({ ok: true, parcela: 'parcela 33/88' });
    expect(pedidos[0]?.anexo.contaFinanceiraId).toBe('5328');
    expect(pedidos[0]?.anexo.filename).toBe('boleto-parcela-33-20270326.pdf');
  });

  it('mês sem parcela em aberto volta ok=false dizendo o que foi pedido', async () => {
    const { spec } = tool([]);
    const r = await spec.execute({ mes: '2030-01' }, session);
    expect(r.rows[0]).toMatchObject({ ok: false });
    // a mensagem tem de citar o MÊS, não um número que ninguém falou
    expect(String((r.rows[0] as { motivo: string }).motivo)).toContain('2030-01');
  });

  /**
   * Os dois juntos criariam a pergunta "qual venceu?" — e a resposta errada
   * manda o boleto errado para o cotista. Nenhum dos dois é igualmente ruim:
   * sem referência, não há o que buscar.
   */
  it('os dois juntos, ou nenhum, são recusados antes de consultar', async () => {
    const { spec, chamadas } = tool([linha]);
    await expect(spec.execute({ parcela: '33', mes: '2027-03' }, session)).rejects.toThrow();
    await expect(spec.execute({}, session)).rejects.toThrow();
    expect(chamadas).toEqual([]); // não chegou a consultar nada
  });

  it('duas parcelas no mesmo mês: pergunta pelo vencimento, não escolhe', async () => {
    const outra = { ...linha, id: '5329', origem: 'entrada', vencimento: '2027-03-05' };
    const { spec } = tool([linha, outra]);
    const r = await spec.execute({ mes: '2027-03' }, session);
    expect(r.rows[0]).toMatchObject({ ok: false });
    expect(String((r.rows[0] as { motivo: string }).motivo)).toContain('2027-03');
  });
});
