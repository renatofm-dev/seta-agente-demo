import { z } from 'zod';
import type {
  CriarUtilizacaoInput,
  OpcaoErp,
  SimulacaoErp,
  SimularUtilizacaoInput,
  UtilizacaoErp,
} from './reserva.js';

/**
 * Fronteira tipada com a API do TS Explorer (036). Dinheiro entra e sai em
 * CENTAVOS — o TSE fala decimal, e a conversão mora aqui, num lugar só.
 */

export type Scalar = string | number | boolean | null;

/** Métodos que a plataforma cobra hoje (014/043). */
export const METODOS = ['pix', 'boleto', 'cartao'] as const;
export type Metodo = (typeof METODOS)[number];

/**
 * `IdMeioPagamento` do TSE. Os ids vêm de `Lookup/MeiosPagamentoContasReceber` e
 * do seed da 012 (BOLETO=1, PIX=2, CARTAORECORRENTE=3).
 */
export const MEIO_PAGAMENTO_TSE: Record<Metodo, number> = { boleto: 1, pix: 2, cartao: 3 };

export const RegistrarPagamentoInputSchema = z.object({
  /** `idcontafinanceira` — o mesmo `titulo_id` que `v_titulo.id` expõe. */
  contaFinanceiraId: z.string().min(1),
  /**
   * `IdContrato`, NUNCA `NumeroContrato`. No TSE são campos diferentes (no
   * exemplo do fornecedor, `IdContrato: 273` e `NumeroContrato: "1"`) e trocar
   * devolve o financeiro de outro cotista — vazamento, não bug.
   */
  contratoId: z.string().min(1),
  valorCentavos: z.number().int().positive(),
  metodo: z.enum(METODOS),
  /** Id da cobrança no PSP (ex.: `pay_yjpuup1ic7tn42tb`) — vai no `CodigoAutorizacao`. */
  referenciaPsp: z.string().min(1),
  pagadorNome: z.string().min(1).nullish(),
  parcelas: z.number().int().min(1).max(36).default(1),
  /** Só existem quando o pagamento foi em cartão; PIX e boleto mandam null. */
  quatroPrimeiros: z.string().length(4).nullish(),
  quatroUltimos: z.string().length(4).nullish(),
});
export type RegistrarPagamentoInput = z.input<typeof RegistrarPagamentoInputSchema>;

export interface ParcelaErp {
  readonly contaFinanceiraId: string;
  readonly contratoId: string;
  readonly valorCentavos: number;
  readonly pago: boolean;
  /** `YYYY-MM-DD` ou null. */
  readonly pagoEm: string | null;
  readonly parcela: number;
}

/**
 * Leitura genérica da API — gêmeo de `DbConnector.execute` para HTTP. Fica
 * exposto porque a 037 vai plugar o catálogo nele; a 036 só usa internamente.
 */
export interface ApiConnector {
  readonly fornecedor: 'tse';
  request(
    r: {
      method: 'GET' | 'POST' | 'PUT';
      path: string;
      query?: Record<string, Scalar>;
      body?: unknown;
    },
    o?: { timeoutMs?: number },
  ): Promise<{ status: number; json: unknown; latencyMs: number }>;
  health(): Promise<{ ok: boolean; latencyMs: number }>;
}

/**
 * Escrita no ERP: TIPADA, nunca dirigida por YAML. O catálogo existe para a
 * leitura que o agente faz; escrita é código, com teste nomeado.
 */
export interface ErpWriter {
  readonly fornecedor: 'tse';
  registrarPagamento(i: RegistrarPagamentoInput): Promise<{ transacaoId: string }>;
  // --- 038: reserva (utilização de contrato) --------------------------------
  listarHoteis(contratoId: string): Promise<OpcaoErp[]>;
  listarTiposUh(idHotel: number): Promise<OpcaoErp[]>;
  simularUtilizacao(i: SimularUtilizacaoInput): Promise<SimulacaoErp>;
  criarUtilizacao(i: CriarUtilizacaoInput): Promise<UtilizacaoErp>;
  confirmarUtilizacao(idUtilizacao: string): Promise<void>;
  cancelarUtilizacao(idUtilizacao: string, motivo: string): Promise<void>;
  lerUtilizacao(idUtilizacao: string): Promise<UtilizacaoErp | null>;
  /** Base do read-back por chave natural quando a resposta da criação se perde. */
  listarUtilizacoes(contratoId: string): Promise<UtilizacaoErp[]>;
  /**
   * Leitura de VERIFICAÇÃO do write (read-back de idempotência). Mora aqui, e
   * não no catálogo, porque não faz parte da superfície do agente.
   */
  lerParcela(contaFinanceiraId: string, contratoId: string): Promise<ParcelaErp | null>;
  health(): Promise<{ ok: boolean; latencyMs: number }>;
}

// --- Zod das respostas do TSE (validados contra as fixtures da 035, sem rede)

export const TokenSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string(),
  expires_in: z.number().int().positive(),
  userName: z.string().optional(),
  userId: z.string().optional(),
});

/** Uma parcela em `PainelDoCliente/FinanceiroContrato`. */
export const ParcelaTseSchema = z.object({
  Identificador: z.number().int(),
  IdContrato: z.number().int(),
  ValorReceber: z.number(),
  Pago: z.boolean(),
  DataPagamento: z.string().nullish(),
  NroParcela: z.number().int(),
});

export const FinanceiroContratoSchema = z.object({
  ListaDados: z.array(ParcelaTseSchema),
  TotalPaginas: z.number().int().nonnegative(),
});

/** Dinheiro: decimal do TSE ⇄ centavos nossos. Nunca float em conta. */
export const reaisParaCentavos = (reais: number): number => Math.round(reais * 100);
export const centavosParaReais = (centavos: number): number => Math.round(centavos) / 100;

export function paraParcelaErp(p: z.infer<typeof ParcelaTseSchema>): ParcelaErp {
  return {
    contaFinanceiraId: String(p.Identificador),
    contratoId: String(p.IdContrato),
    valorCentavos: reaisParaCentavos(p.ValorReceber),
    pago: p.Pago,
    pagoEm: p.DataPagamento ? p.DataPagamento.slice(0, 10) : null,
    parcela: p.NroParcela,
  };
}
