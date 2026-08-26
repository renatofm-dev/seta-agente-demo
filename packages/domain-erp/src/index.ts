/**
 * Tipos canônicos do domínio ERP (contrato entre erp-mock, query-catalog e agente).
 * Só tipos e constantes — zero dependências, por regra da spec 001.
 */

export const BOLETO_STATUS = ['aberto', 'pago', 'vencido', 'cancelado'] as const;
export type BoletoStatus = (typeof BOLETO_STATUS)[number];

export const PEDIDO_STATUS = [
  'recebido',
  'faturado',
  'em_separacao',
  'em_transporte',
  'entregue',
  'cancelado',
] as const;
export type PedidoStatus = (typeof PEDIDO_STATUS)[number];

/** Data no formato ISO 8601 (YYYY-MM-DD). */
export type ISODate = string;

export interface Cliente {
  readonly id: string;
  readonly documento: string;
  readonly razaoSocial: string;
  readonly nomeFantasia: string | null;
}

export interface Boleto {
  readonly id: string;
  readonly clienteId: string;
  readonly valorCentavos: number;
  readonly vencimento: ISODate;
  readonly status: BoletoStatus;
  readonly linhaDigitavel: string | null;
}

export interface Pedido {
  readonly id: string;
  readonly clienteId: string;
  readonly emissao: ISODate;
  readonly status: PedidoStatus;
  readonly totalCentavos: number;
}
