import { z } from 'zod';

/**
 * Port PaymentProvider (spec 014 / ADR 0001). Dinheiro SEMPRE em centavos nesta
 * fronteira — a conversão para o formato do gateway é responsabilidade do adapter.
 */

export const METODOS_PAGAMENTO = ['boleto', 'pix', 'cartao'] as const;
export type MetodoPagamento = (typeof METODOS_PAGAMENTO)[number];
export const MetodoPagamentoSchema = z.enum(METODOS_PAGAMENTO);

/** CPF (11 dígitos) ou CNPJ (14) — só dígitos. */
export const DocumentoSchema = z.string().regex(/^(\d{11}|\d{14})$/, 'CPF/CNPJ só com dígitos');

export const ClienteInputSchema = z.object({
  documento: DocumentoSchema,
  nome: z.string().min(1).max(200),
  email: z.email().optional(),
  /** E.164 sem `+` (mesmo formato do wa_id). */
  telefone: z
    .string()
    .regex(/^\d{8,15}$/)
    .optional(),
  /** Identificador nosso no gateway (ex.: `contrato:10002`) — busca antes de criar. */
  referenciaExterna: z.string().min(1).max(200),
});
export type ClienteInput = z.infer<typeof ClienteInputSchema>;

export const CobrancaInputSchema = z.object({
  clienteId: z.string().min(1),
  valorCentavos: z.number().int().positive(),
  /** YYYY-MM-DD */
  vencimento: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  descricao: z.string().min(1).max(500),
  /** Determinística por contrato+títulos — chave de idempotência no gateway. */
  referenciaExterna: z.string().min(1).max(200),
  metodo: MetodoPagamentoSchema,
});
export type CobrancaInput = z.infer<typeof CobrancaInputSchema>;

export const STATUS_COBRANCA_PSP = [
  'pendente',
  'recebida',
  'confirmada',
  'vencida',
  'estornada',
  'cancelada',
  'desconhecida',
] as const;
export type StatusCobrancaPsp = (typeof STATUS_COBRANCA_PSP)[number];

export interface CobrancaPsp {
  readonly id: string;
  readonly status: StatusCobrancaPsp;
  /** Status como o gateway devolveu (auditoria). */
  readonly statusBruto: string;
  readonly valorCentavos: number;
  readonly vencimento: string;
  /** Página de pagamento (cartão, e fallback para qualquer método). */
  readonly urlFatura: string;
  readonly urlBoleto: string | null;
  readonly referenciaExterna: string | null;
}

export interface PaymentProvider {
  readonly nome: 'asaas' | 'simulado';
  readonly ambiente: 'sandbox' | 'producao' | 'simulado';
  /** Busca por referência/documento e cria se não houver — idempotente. */
  garantirCliente(c: ClienteInput): Promise<{ id: string }>;
  criarCobranca(c: CobrancaInput): Promise<CobrancaPsp>;
  /** Anti-duplicidade: consultar SEMPRE antes de criar. */
  buscarPorReferencia(referenciaExterna: string): Promise<CobrancaPsp | null>;
  cancelarCobranca(id: string): Promise<void>;
  obterPix(id: string): Promise<{ payload: string; expiraEm: string | null }>;
  obterLinhaDigitavel(id: string): Promise<{ linhaDigitavel: string; codigoBarras: string | null }>;
  /** Dev/sandbox: marca como recebida (no Asaas dispara o webhook real). */
  simularRecebimento(id: string, valorCentavos: number): Promise<void>;
  health(): Promise<{ ok: boolean; latencyMs: number }>;
}

/** Centavos → reais com 2 casas (formato do gateway). 85050 → 850.5 */
export function centavosParaReais(centavos: number): number {
  return Number((centavos / 100).toFixed(2));
}

/** Reais (decimal do gateway) → centavos inteiros. 850.5 → 85050 */
export function reaisParaCentavos(reais: number): number {
  return Math.round(reais * 100);
}
