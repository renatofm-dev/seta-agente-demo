import type { MetodoPagamento } from '@seta/payment-provider';

/**
 * Domínio do agente de cobrança (spec 014). Puro: sem banco, sem ERP — os
 * títulos chegam já lidos pelo catálogo e o resultado diz ao server o que fazer.
 */

export interface Candidato {
  /** id do título no ERP (v_titulo.id). */
  readonly tituloId: string;
  readonly origem: 'entrada' | 'saldo';
  readonly parcela: number;
  readonly totalParcelas: number | null;
  readonly valorCentavos: number;
  /** YYYY-MM-DD */
  readonly vencimento: string;
  readonly situacao: 'vencida' | 'a_vencer';
}

export const ETAPAS = ['selecao', 'metodo', 'confirmacao', 'encerrado'] as const;
export type Etapa = (typeof ETAPAS)[number];

export const ENCERRAMENTOS = [
  'emitindo',
  'cancelado',
  'sem_pendencia',
  'bloqueado',
  'abandonado',
  'limite_dia',
  'expirado',
  'sem_documento',
] as const;
export type Encerramento = (typeof ENCERRAMENTOS)[number];

export interface EstadoFluxo {
  readonly etapa: Etapa;
  readonly candidatos: readonly Candidato[];
  /** ids dos títulos escolhidos. */
  readonly selecao: readonly string[];
  readonly metodo: MetodoPagamento | null;
  readonly naoEntendi: number;
  readonly encerramento: Encerramento | null;
}

export type Acao =
  | { readonly tipo: 'escolher'; readonly indice: number }
  | { readonly tipo: 'todas' }
  | { readonly tipo: 'metodo'; readonly metodo: MetodoPagamento }
  | { readonly tipo: 'confirmar' }
  | { readonly tipo: 'cancelar' }
  | { readonly tipo: 'nao_entendi' };

/** Regras de negócio que o server resolve antes de iniciar o fluxo. */
export interface ContextoFluxo {
  readonly tetoCentavos: number;
  readonly maxPorDia: number;
  readonly cobrancasHoje: number;
  readonly contratoStatus: 'ativo' | 'cancelado' | 'quitado' | null;
  readonly distratoEmAnalise: boolean;
  readonly temDocumento: boolean;
}

export type Efeito =
  | 'nenhum'
  /** Total dentro do teto: criar cobrança `emitindo` e enfileirar a emissão. */
  | 'emitir'
  /** Total acima do teto: criar cobrança `aguardando_aprovacao` e escalar. */
  | 'emitir_com_aprovacao'
  /** Bloqueio/limite/sem documento: escalar para humano. */
  | 'escalar_bloqueio';

export interface Transicao {
  readonly estado: EstadoFluxo;
  readonly mensagens: readonly string[];
  readonly efeito: Efeito;
}

/** Opção numerada apresentada ao cliente na etapa de seleção. */
export type Opcao =
  | { readonly tipo: 'titulo'; readonly candidato: Candidato }
  | { readonly tipo: 'todas_vencidas'; readonly candidatos: readonly Candidato[] };

/** Máximo de vencidas listadas uma a uma (o resto entra em "todas"). */
export const MAX_VENCIDAS_LISTADAS = 5;

export function vencidasDe(estado: Pick<EstadoFluxo, 'candidatos'>): Candidato[] {
  return estado.candidatos.filter((c) => c.situacao === 'vencida');
}

/** Opções numeradas, na ordem exibida — render e parser compartilham isto. */
export function opcoesDe(estado: Pick<EstadoFluxo, 'candidatos'>): Opcao[] {
  const vencidas = vencidasDe(estado);
  const aVencer = estado.candidatos.filter((c) => c.situacao === 'a_vencer');
  const opcoes: Opcao[] = vencidas
    .slice(0, MAX_VENCIDAS_LISTADAS)
    .map((c) => ({ tipo: 'titulo' as const, candidato: c }));
  for (const c of aVencer) opcoes.push({ tipo: 'titulo', candidato: c });
  if (vencidas.length >= 2) opcoes.push({ tipo: 'todas_vencidas', candidatos: vencidas });
  return opcoes;
}

export function selecionados(estado: Pick<EstadoFluxo, 'candidatos' | 'selecao'>): Candidato[] {
  const ids = new Set(estado.selecao);
  return estado.candidatos.filter((c) => ids.has(c.tituloId));
}

export function totalSelecionado(estado: Pick<EstadoFluxo, 'candidatos' | 'selecao'>): number {
  return selecionados(estado).reduce((acc, c) => acc + c.valorCentavos, 0);
}
