import type { Executor, RunResult, SessionCtx } from '@seta/query-catalog';
import { isoDia } from './candidatos.js';
import type { PagoDoContrato } from './repo.js';

/**
 * Conciliação (014): decorator do port Executor que faz as leituras
 * `financeiro.*` do ERP refletirem as baixas registradas na tabela `pagamento`
 * (o espelho do que o ERP faria). Em produção o ERP recebe a baixa e esta
 * camada desaparece — por isso ela fica atrás do port, transparente para o
 * agente, o fluxo e o catálogo.
 */

export interface RepoConciliacao {
  pagosDoContrato(contratoId: string): Promise<PagoDoContrato[]>;
}

type Row = Record<string, unknown>;

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function diasDeAtraso(vencimento: string, hoje: Date): number {
  const [y, m, d] = vencimento.split('-').map(Number);
  const venc = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  const ref = Date.UTC(hoje.getFullYear(), hoje.getMonth(), hoje.getDate());
  return Math.max(0, Math.floor((ref - venc) / 86_400_000));
}

function semPagos(rows: readonly Row[], pagos: ReadonlySet<string>): Row[] {
  return rows.filter((r) => !pagos.has(String(r.id)));
}

/** titulos_atraso: remove os pagos e recalcula o resumo da inadimplência nas restantes. */
export function conciliarAtraso(r: RunResult, pagos: ReadonlySet<string>, hoje: Date): RunResult {
  const rows = semPagos(r.rows, pagos);
  if (rows.length === r.rows.length) return r;
  if (rows.length === 0) return { rows: [], rowCount: 0, truncated: false };
  const vencimentos = rows.map((x) => isoDia(x.vencimento));
  const maisAntigo = [...vencimentos].sort()[0] ?? null;
  const resumo = {
    qtd_titulos_vencidos: rows.length,
    saldo_vencido_centavos: rows.reduce((acc, x) => acc + num(x.valor_centavos), 0),
    vencimento_mais_antigo: maisAntigo,
    maior_atraso_dias: Math.max(...vencimentos.map((v) => diasDeAtraso(v, hoje))),
  };
  return {
    rows: rows.map((x) => ({ ...x, ...resumo })),
    rowCount: rows.length,
    truncated: r.truncated,
  };
}

/** saldo_contrato: subtrai os pagos (count e soma) e recalcula o próximo vencimento. */
export function conciliarSaldo(
  r: RunResult,
  pagos: readonly PagoDoContrato[],
  proximoVencimento: string | null,
): RunResult {
  const row = r.rows[0];
  if (!row || pagos.length === 0) return r;
  const abertas = Math.max(0, num(row.parcelas_em_aberto) - pagos.length);
  const saldo = Math.max(
    0,
    num(row.saldo_devedor_centavos) - pagos.reduce((acc, p) => acc + p.valorCentavos, 0),
  );
  return {
    ...r,
    rows: [
      {
        ...row,
        parcelas_em_aberto: abertas,
        saldo_devedor_centavos: saldo,
        proximo_vencimento: abertas === 0 ? null : proximoVencimento,
      },
    ],
  };
}

/** total_pago: soma os pagos por origem (cria a linha da origem se não existir). */
export function conciliarTotalPago(r: RunResult, pagos: readonly PagoDoContrato[]): RunResult {
  if (pagos.length === 0) return r;
  const porOrigem = new Map<string, Row>();
  for (const row of r.rows) porOrigem.set(String(row.origem), { ...row });
  for (const p of pagos) {
    const atual = porOrigem.get(p.origem) ?? {
      origem: p.origem,
      parcelas_pagas: 0,
      total_pago_centavos: 0,
    };
    porOrigem.set(p.origem, {
      ...atual,
      parcelas_pagas: num(atual.parcelas_pagas) + 1,
      total_pago_centavos: num(atual.total_pago_centavos) + p.valorCentavos,
    });
  }
  const rows = [...porOrigem.values()].sort((a, b) =>
    String(a.origem).localeCompare(String(b.origem)),
  );
  return { rows, rowCount: rows.length, truncated: r.truncated };
}

export interface ConciliacaoOptions {
  readonly hoje?: () => Date;
}

export function createExecutorConciliado(
  executor: Executor,
  repo: RepoConciliacao,
  opts: ConciliacaoOptions = {},
): Executor {
  const hoje = opts.hoje ?? (() => new Date());

  const proximoVencimento = async (
    session: SessionCtx,
    pagosIds: ReadonlySet<string>,
  ): Promise<string | null> => {
    const [atraso, proximas] = await Promise.all([
      executor.run('financeiro.titulos_atraso', {}, session),
      executor.run('financeiro.proximas_parcelas', {}, session),
    ]);
    const abertas = [...semPagos(atraso.rows, pagosIds), ...semPagos(proximas.rows, pagosIds)];
    const datas = abertas.map((x) => isoDia(x.vencimento)).sort();
    return datas[0] ?? null;
  };

  const conciliado: Executor = {
    async run(id, rawParams, session) {
      const r = await executor.run(id, rawParams, session);
      if (!id.startsWith('financeiro.')) return r;
      const pagos = await repo.pagosDoContrato(session.clienteId).catch(() => []);
      if (pagos.length === 0) return r;
      const pagosIds = new Set(pagos.map((p) => p.tituloId));

      switch (id) {
        case 'financeiro.titulos_atraso':
          return conciliarAtraso(r, pagosIds, hoje());
        case 'financeiro.proximas_parcelas': {
          const rows = semPagos(r.rows, pagosIds);
          return { rows, rowCount: rows.length, truncated: r.truncated };
        }
        case 'financeiro.proxima_parcela': {
          const atual = r.rows[0];
          if (!atual || !pagosIds.has(String(atual.id))) return r;
          // a "próxima" já foi paga por aqui: pega a seguinte não paga
          const proximas = await executor.run('financeiro.proximas_parcelas', {}, session);
          const seguinte = semPagos(proximas.rows, pagosIds)[0];
          return seguinte
            ? { rows: [seguinte], rowCount: 1, truncated: false }
            : { rows: [], rowCount: 0, truncated: false };
        }
        case 'financeiro.saldo_contrato':
          return conciliarSaldo(r, pagos, await proximoVencimento(session, pagosIds));
        case 'financeiro.total_pago':
          return conciliarTotalPago(r, pagos);
        default:
          return r;
      }
    },
  };
  return conciliado;
}
