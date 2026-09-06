import type { Executor, SessionCtx } from '@seta/query-catalog';
import type { CotaDisponivel, Perfil } from '@seta/sdr';

/**
 * Lê do ERP (via catálogo) as cotas disponíveis que casam o perfil da
 * qualificação. Todo valor vem daqui — o modelo nunca decide quanto.
 */

function inteiro(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

export function cotaDeLinha(row: Record<string, unknown>): CotaDisponivel {
  return {
    cotaId: String(row.cota_id),
    cotaCodigo: String(row.cota_codigo),
    bloco: String(row.bloco),
    andar: inteiro(row.andar),
    uh: String(row.uh),
    capacidade: inteiro(row.capacidade),
    tier: String(row.tier),
    modelo: String(row.modelo),
    periodos: inteiro(row.periodos),
    valorTabelaCentavos: inteiro(row.valor_tabela_centavos),
  };
}

export async function lerEstoque(
  executor: Executor,
  session: SessionCtx,
  perfil: Pick<Perfil, 'pessoas' | 'periodos'>,
): Promise<CotaDisponivel[]> {
  const r = await executor.run(
    'comercial.estoque_disponivel',
    { capacidade_min: perfil.pessoas ?? 1, periodos: perfil.periodos ?? 0 },
    session,
  );
  return r.rows.map(cotaDeLinha);
}
