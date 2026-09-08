import type { Executor, RunResult } from '@seta/query-catalog';
import { describe, expect, it } from 'vitest';
import { createExecutorConciliado } from '../src/pagamentos/conciliacao.ts';
import type { PagoDoContrato } from '../src/pagamentos/repo.ts';

/** Executor stub: devolve por id o que o ERP devolveria (valores como o pg manda: strings). */
function executorStub(respostas: Record<string, RunResult>): Executor & { chamadas: string[] } {
  const chamadas: string[] = [];
  return {
    chamadas,
    async run(id) {
      chamadas.push(id);
      const r = respostas[id];
      if (!r) throw new Error(`stub sem resposta para ${id}`);
      return r;
    },
  };
}

const SESSION = { traceId: 't', clienteId: '10002' };
const HOJE = new Date(2026, 8, 2); // 02/09/2026

const atraso = (rows: Record<string, unknown>[]): RunResult => ({
  rows,
  rowCount: rows.length,
  truncated: false,
});

const VENCIDAS = atraso([
  {
    id: 11,
    origem: 'saldo',
    parcela: 12,
    valor_centavos: '85000',
    vencimento: new Date(2026, 5, 10),
    qtd_titulos_vencidos: '3',
    saldo_vencido_centavos: '255000',
    vencimento_mais_antigo: new Date(2026, 5, 10),
    maior_atraso_dias: 84,
  },
  {
    id: 12,
    origem: 'saldo',
    parcela: 13,
    valor_centavos: '85000',
    vencimento: new Date(2026, 6, 10),
    qtd_titulos_vencidos: '3',
    saldo_vencido_centavos: '255000',
    vencimento_mais_antigo: new Date(2026, 5, 10),
    maior_atraso_dias: 84,
  },
  {
    id: 13,
    origem: 'saldo',
    parcela: 14,
    valor_centavos: '85000',
    vencimento: new Date(2026, 7, 10),
    qtd_titulos_vencidos: '3',
    saldo_vencido_centavos: '255000',
    vencimento_mais_antigo: new Date(2026, 5, 10),
    maior_atraso_dias: 84,
  },
]);
const PROXIMAS = atraso([
  { id: 14, origem: 'saldo', parcela: 15, valor_centavos: '85000', vencimento: '2026-10-10' },
  { id: 15, origem: 'saldo', parcela: 16, valor_centavos: '85000', vencimento: '2026-11-10' },
]);
const PROXIMA = atraso([PROXIMAS.rows[0] as Record<string, unknown>]);
const SALDO = atraso([
  {
    parcelas_em_aberto: '100',
    saldo_devedor_centavos: '8500000',
    proximo_vencimento: '2026-06-10',
  },
]);
const TOTAL_PAGO = atraso([
  { origem: 'entrada', parcelas_pagas: '10', total_pago_centavos: '500000' },
]);

const RESPOSTAS = {
  'financeiro.titulos_atraso': VENCIDAS,
  'financeiro.proximas_parcelas': PROXIMAS,
  'financeiro.proxima_parcela': PROXIMA,
  'financeiro.saldo_contrato': SALDO,
  'financeiro.total_pago': TOTAL_PAGO,
  'contrato.meu_produto': atraso([{ status: 'ativo' }]),
};

function repoCom(pagos: PagoDoContrato[]) {
  return { pagosDoContrato: async () => pagos };
}

describe('spec 014 — conciliação (baixa espelhada sobre as leituras do ERP)', () => {
  it('sem pagamento registrado, devolve o resultado do ERP intacto e não toca fora de financeiro.*', async () => {
    const stub = executorStub(RESPOSTAS);
    const ex = createExecutorConciliado(stub, repoCom([]), { hoje: () => HOJE });
    expect(await ex.run('financeiro.titulos_atraso', {}, SESSION)).toBe(VENCIDAS);
    expect(await ex.run('contrato.meu_produto', {}, SESSION)).toEqual(
      RESPOSTAS['contrato.meu_produto'],
    );
  });

  it('título pago some de titulos_atraso e o resumo da inadimplência é recalculado', async () => {
    const stub = executorStub(RESPOSTAS);
    const pagos = [
      { tituloId: '11', origem: 'saldo' as const, valorCentavos: 85000, recebidoEm: HOJE },
    ];
    const ex = createExecutorConciliado(stub, repoCom(pagos), { hoje: () => HOJE });
    const r = await ex.run('financeiro.titulos_atraso', {}, SESSION);
    expect(r.rowCount).toBe(2);
    expect(r.rows.map((x) => x.id)).toEqual([12, 13]);
    expect(r.rows[0]).toMatchObject({
      qtd_titulos_vencidos: 2,
      saldo_vencido_centavos: 170000,
      vencimento_mais_antigo: '2026-07-10',
      maior_atraso_dias: 54, // 10/07 → 02/09
    });
  });

  it('todas pagas ⇒ lista vazia (contrato em dia)', async () => {
    const stub = executorStub(RESPOSTAS);
    const pagos = ['11', '12', '13'].map((tituloId) => ({
      tituloId,
      origem: 'saldo' as const,
      valorCentavos: 85000,
      recebidoEm: HOJE,
    }));
    const ex = createExecutorConciliado(stub, repoCom(pagos), { hoje: () => HOJE });
    expect(await ex.run('financeiro.titulos_atraso', {}, SESSION)).toEqual({
      rows: [],
      rowCount: 0,
      truncated: false,
    });
  });

  it('proxima_parcela pula a que foi paga por aqui; proximas_parcelas filtra', async () => {
    const stub = executorStub(RESPOSTAS);
    const pagos = [
      { tituloId: '14', origem: 'saldo' as const, valorCentavos: 85000, recebidoEm: HOJE },
    ];
    const ex = createExecutorConciliado(stub, repoCom(pagos), { hoje: () => HOJE });
    const r = await ex.run('financeiro.proxima_parcela', {}, SESSION);
    expect(r.rows[0]?.id).toBe(15);
    const p = await ex.run('financeiro.proximas_parcelas', {}, SESSION);
    expect(p.rows.map((x) => x.id)).toEqual([15]);
  });

  it('saldo_contrato subtrai os pagos e recalcula o próximo vencimento; total_pago soma por origem', async () => {
    const stub = executorStub(RESPOSTAS);
    const pagos = [
      { tituloId: '11', origem: 'saldo' as const, valorCentavos: 85000, recebidoEm: HOJE },
      { tituloId: '12', origem: 'saldo' as const, valorCentavos: 85000, recebidoEm: HOJE },
    ];
    const ex = createExecutorConciliado(stub, repoCom(pagos), { hoje: () => HOJE });
    const saldo = await ex.run('financeiro.saldo_contrato', {}, SESSION);
    expect(saldo.rows[0]).toMatchObject({
      parcelas_em_aberto: 98,
      saldo_devedor_centavos: 8330000,
      proximo_vencimento: '2026-08-10',
    });
    const total = await ex.run('financeiro.total_pago', {}, SESSION);
    expect(total.rows).toEqual([
      { origem: 'entrada', parcelas_pagas: '10', total_pago_centavos: '500000' },
      { origem: 'saldo', parcelas_pagas: 2, total_pago_centavos: 170000 },
    ]);
  });
});
