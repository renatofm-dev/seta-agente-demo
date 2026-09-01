/**
 * Tipos canônicos do domínio ERP (contrato entre erp-mock, query-catalog e agente).
 * Domínio da spec 012: multipropriedade (TS Explorer). A unidade vendável é a
 * COTA (fração de uso de uma UH); o financeiro é crediário próprio por parcela.
 * Só tipos e constantes — zero dependências, por regra da spec 001.
 */

/** Data no formato ISO 8601 (YYYY-MM-DD). */
export type ISODate = string;

/** ATIVO + ATIVOREV da física viram 'ativo' — contar só ATIVO perde contratos. */
export const CONTRATO_STATUS = ['ativo', 'cancelado', 'quitado'] as const;
export type ContratoStatus = (typeof CONTRATO_STATUS)[number];

/** v_titulo só expõe histórico ATIVO; o status é derivado de pagamento/vencimento. */
export const TITULO_STATUS = ['aberto', 'pago', 'vencido'] as const;
export type TituloStatus = (typeof TITULO_STATUS)[number];

/** Origem da parcela no crediário (contrato = Entrada + Saldo). */
export const TITULO_ORIGEM = ['entrada', 'saldo'] as const;
export type TituloOrigem = (typeof TITULO_ORIGEM)[number];

export const MEIO_PAGAMENTO = ['boleto', 'pix', 'cartao_recorrente'] as const;
export type MeioPagamento = (typeof MEIO_PAGAMENTO)[number];

export const CANCELAMENTO_STATUS = ['em_analise', 'concluido', 'negado'] as const;
export type CancelamentoStatus = (typeof CANCELAMENTO_STATUS)[number];

export const CHAMADO_STATUS = ['aberto', 'em_andamento', 'finalizado'] as const;
export type ChamadoStatus = (typeof CHAMADO_STATUS)[number];

/** Tiers comercializados (grupocota): OURO/DIAMANTE × PREMIUM/MASTER/SPECIAL. */
export const COTA_TIERS = [
  'OURO PREMIUM',
  'OURO MASTER',
  'OURO SPECIAL',
  'DIAMANTE PREMIUM',
  'DIAMANTE MASTER',
  'DIAMANTE SPECIAL',
] as const;
export type CotaTier = (typeof COTA_TIERS)[number];

/** Titular SEMPRE pseudonimizado ("Titular do contrato NNNNN") — LGPD na view. */
export interface Cotista {
  readonly contratoId: string;
  readonly numeroContrato: string;
  readonly titular: string;
  readonly status: ContratoStatus;
  readonly clienteDesde: ISODate;
}

export interface ContratoCota {
  readonly contratoId: string;
  readonly numeroContrato: string;
  readonly cotaCodigo: string;
  readonly bloco: string;
  readonly andar: number;
  readonly uh: string;
  readonly capacidade: number;
  readonly tier: CotaTier;
  readonly periodos: number;
  readonly pontos: number;
  readonly status: ContratoStatus;
}

export interface Titulo {
  readonly id: string;
  readonly contratoId: string;
  readonly origem: TituloOrigem;
  readonly parcela: number;
  readonly totalParcelas: number;
  readonly meioPagamento: MeioPagamento;
  readonly valorCentavos: number;
  readonly valorPagoCentavos: number;
  readonly vencimento: ISODate;
  readonly pagamento: ISODate | null;
  readonly status: TituloStatus;
  readonly linhaDigitavel: string | null;
  readonly pixCopiaCola: string | null;
}

export interface Inadimplencia {
  readonly contratoId: string;
  readonly qtdTitulosVencidos: number;
  readonly saldoVencidoCentavos: number;
  readonly vencimentoMaisAntigo: ISODate;
  readonly maiorAtrasoDias: number;
}

export interface Cancelamento {
  readonly contratoId: string;
  readonly status: CancelamentoStatus;
  readonly motivo: string;
  readonly solicitadoEm: ISODate;
  readonly multaCentavos: number;
  readonly reembolsoCentavos: number;
}

export interface Chamado {
  readonly id: string;
  readonly contratoId: string;
  readonly status: ChamadoStatus;
  readonly motivo: string;
  readonly abertura: ISODate;
  readonly finalizacao: ISODate | null;
}
