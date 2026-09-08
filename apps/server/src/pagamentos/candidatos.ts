import type { Candidato } from '@seta/cobranca';
import type { Executor, SessionCtx } from '@seta/query-catalog';

/**
 * Lê do ERP (via catálogo, com a conciliação por cima) o que o fluxo precisa:
 * parcelas vencidas + a próxima a vencer, status do contrato e distrato.
 * Todo valor vem daqui — o modelo nunca decide quanto.
 */

export interface DadosContrato {
  readonly candidatos: Candidato[];
  readonly contratoStatus: 'ativo' | 'cancelado' | 'quitado' | null;
  readonly distratoEmAnalise: boolean;
}

/** Data do ERP (Date do pg ou string) → YYYY-MM-DD, sem deslocar o dia por fuso. */
export function isoDia(v: unknown): string {
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(v).slice(0, 10);
}

function inteiro(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function origemDe(v: unknown): 'entrada' | 'saldo' {
  return v === 'entrada' ? 'entrada' : 'saldo';
}

export function candidatoDeLinha(
  row: Record<string, unknown>,
  situacao: Candidato['situacao'],
): Candidato {
  return {
    tituloId: String(row.id),
    origem: origemDe(row.origem),
    parcela: inteiro(row.parcela),
    totalParcelas: row.total_parcelas == null ? null : inteiro(row.total_parcelas),
    valorCentavos: inteiro(row.valor_centavos),
    vencimento: isoDia(row.vencimento),
    situacao,
  };
}

export async function lerDadosContrato(
  executor: Executor,
  session: SessionCtx,
): Promise<DadosContrato> {
  const [vencidas, proximas, produto, cancelamento] = await Promise.all([
    executor.run('financeiro.titulos_atraso', {}, session),
    executor.run('financeiro.proximas_parcelas', {}, session),
    executor.run('contrato.meu_produto', {}, session),
    executor.run('contrato.status_cancelamento', {}, session),
  ]);

  const candidatos = vencidas.rows.map((r) => candidatoDeLinha(r, 'vencida'));
  const ids = new Set(candidatos.map((c) => c.tituloId));
  const proxima = proximas.rows.find((r) => !ids.has(String(r.id)));
  if (proxima) candidatos.push(candidatoDeLinha(proxima, 'a_vencer'));

  const status = produto.rows[0]?.status;
  const contratoStatus =
    status === 'ativo' || status === 'cancelado' || status === 'quitado' ? status : null;
  const distratoEmAnalise = cancelamento.rows[0]?.status === 'em_analise';

  return { candidatos, contratoStatus, distratoEmAnalise };
}
