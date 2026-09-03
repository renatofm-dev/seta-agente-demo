import { z } from 'zod';
import { erroDeResposta, PspUnavailableError } from './erros.js';
import {
  ClienteInputSchema,
  CobrancaInputSchema,
  type CobrancaPsp,
  centavosParaReais,
  type MetodoPagamento,
  type PaymentProvider,
  reaisParaCentavos,
  type StatusCobrancaPsp,
} from './tipos.js';

/**
 * Adapter Asaas (API v3) via fetch — sem SDK. Campos conferidos na documentação
 * oficial em 2026-09-02 (docs.asaas.com): header `access_token` (não é Bearer),
 * `User-Agent` obrigatório, valores em reais decimal, `dueDate` YYYY-MM-DD.
 */

export interface AsaasConfig {
  /** `https://api-sandbox.asaas.com/v3` | `https://api.asaas.com/v3` */
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs?: number;
  readonly userAgent?: string;
}

export function ambienteDaUrl(baseUrl: string): 'sandbox' | 'producao' {
  return /sandbox/i.test(baseUrl) ? 'sandbox' : 'producao';
}

const BILLING_TYPE: Record<MetodoPagamento, string> = {
  boleto: 'BOLETO',
  pix: 'PIX',
  cartao: 'CREDIT_CARD',
};

const PaymentDtoSchema = z.object({
  id: z.string().min(1),
  status: z.string(),
  value: z.number(),
  dueDate: z.string(),
  invoiceUrl: z.string(),
  bankSlipUrl: z.string().nullish(),
  externalReference: z.string().nullish(),
  deleted: z.boolean().optional(),
});
type PaymentDto = z.infer<typeof PaymentDtoSchema>;

const ListaSchema = z.object({ data: z.array(z.unknown()) });
const ClienteDtoSchema = z.object({ id: z.string().min(1) });
const PixDtoSchema = z.object({ payload: z.string().min(1), expirationDate: z.string().nullish() });
const LinhaDtoSchema = z.object({
  identificationField: z.string().min(1),
  barCode: z.string().nullish(),
});

/** Status do Asaas → domínio. Desconhecido nunca vira "paga". */
export function statusDoAsaas(bruto: string, deleted = false): StatusCobrancaPsp {
  if (deleted) return 'cancelada';
  switch (bruto) {
    case 'PENDING':
    case 'AWAITING_RISK_ANALYSIS':
    case 'AUTHORIZED':
      return 'pendente';
    case 'RECEIVED':
    case 'RECEIVED_IN_CASH':
    case 'DUNNING_RECEIVED':
      return 'recebida';
    case 'CONFIRMED':
      return 'confirmada';
    case 'OVERDUE':
      return 'vencida';
    case 'REFUNDED':
    case 'REFUND_REQUESTED':
    case 'REFUND_IN_PROGRESS':
    case 'CHARGEBACK_REQUESTED':
    case 'CHARGEBACK_DISPUTE':
    case 'AWAITING_CHARGEBACK_REVERSAL':
      return 'estornada';
    default:
      return 'desconhecida';
  }
}

function paraCobranca(dto: PaymentDto): CobrancaPsp {
  return {
    id: dto.id,
    status: statusDoAsaas(dto.status, dto.deleted === true),
    statusBruto: dto.status,
    valorCentavos: reaisParaCentavos(dto.value),
    vencimento: dto.dueDate,
    urlFatura: dto.invoiceUrl,
    urlBoleto: dto.bankSlipUrl ?? null,
    referenciaExterna: dto.externalReference ?? null,
  };
}

function hojeIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function createAsaasProvider(config: AsaasConfig): PaymentProvider {
  const fetchFn = config.fetchFn ?? fetch;
  const base = config.baseUrl.replace(/\/+$/, '');
  const timeoutMs = config.timeoutMs ?? 15_000;
  const userAgent = config.userAgent ?? 'seta-agente/0.1';

  async function request(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    let res: Response;
    try {
      res = await fetchFn(`${base}${path}`, {
        method,
        headers: {
          access_token: config.apiKey,
          'user-agent': userAgent,
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // rede, DNS, abort por timeout: transitório
      throw new PspUnavailableError(
        `PSP sem resposta em ${method} ${path}: ${err instanceof Error ? err.message : err}`,
      );
    }
    if (!res.ok) {
      throw erroDeResposta(`${method} ${path}`, res.status, await res.text());
    }
    const texto = await res.text();
    return texto.length > 0 ? JSON.parse(texto) : {};
  }

  const listar = async (path: string): Promise<unknown[]> =>
    ListaSchema.parse(await request('GET', path)).data;

  return {
    nome: 'asaas',
    ambiente: ambienteDaUrl(config.baseUrl),

    async garantirCliente(input) {
      const c = ClienteInputSchema.parse(input);
      const porRef = await listar(
        `/customers?externalReference=${encodeURIComponent(c.referenciaExterna)}&limit=1`,
      );
      if (porRef[0]) return { id: ClienteDtoSchema.parse(porRef[0]).id };
      const porDoc = await listar(`/customers?cpfCnpj=${encodeURIComponent(c.documento)}&limit=1`);
      if (porDoc[0]) return { id: ClienteDtoSchema.parse(porDoc[0]).id };
      const criado = await request('POST', '/customers', {
        name: c.nome,
        cpfCnpj: c.documento,
        ...(c.email ? { email: c.email } : {}),
        ...(c.telefone ? { mobilePhone: c.telefone } : {}),
        externalReference: c.referenciaExterna,
        // quem avisa o cotista é o nosso WhatsApp, não o e-mail do gateway
        notificationDisabled: true,
      });
      return { id: ClienteDtoSchema.parse(criado).id };
    },

    async criarCobranca(input) {
      const c = CobrancaInputSchema.parse(input);
      const dto = await request('POST', '/payments', {
        customer: c.clienteId,
        billingType: BILLING_TYPE[c.metodo],
        value: centavosParaReais(c.valorCentavos),
        dueDate: c.vencimento,
        description: c.descricao,
        externalReference: c.referenciaExterna,
      });
      return paraCobranca(PaymentDtoSchema.parse(dto));
    },

    async buscarPorReferencia(referenciaExterna) {
      const itens = await listar(
        `/payments?externalReference=${encodeURIComponent(referenciaExterna)}&limit=20`,
      );
      const cobrancas = itens.map((i) => paraCobranca(PaymentDtoSchema.parse(i)));
      // a aberta vale mais que uma cancelada/estornada antiga com a mesma referência
      return (
        cobrancas.find((c) => c.status === 'pendente' || c.status === 'vencida') ??
        cobrancas.find((c) => c.status === 'recebida' || c.status === 'confirmada') ??
        cobrancas[0] ??
        null
      );
    },

    async cancelarCobranca(id) {
      await request('DELETE', `/payments/${encodeURIComponent(id)}`);
    },

    async obterPix(id) {
      const dto = PixDtoSchema.parse(
        await request('GET', `/payments/${encodeURIComponent(id)}/pixQrCode`),
      );
      return { payload: dto.payload, expiraEm: dto.expirationDate ?? null };
    },

    async obterLinhaDigitavel(id) {
      const dto = LinhaDtoSchema.parse(
        await request('GET', `/payments/${encodeURIComponent(id)}/identificationField`),
      );
      return { linhaDigitavel: dto.identificationField, codigoBarras: dto.barCode ?? null };
    },

    async simularRecebimento(id, valorCentavos) {
      await request('POST', `/payments/${encodeURIComponent(id)}/receiveInCash`, {
        paymentDate: hojeIso(),
        value: centavosParaReais(valorCentavos),
        notifyCustomer: false,
      });
    },

    async health() {
      const t0 = Date.now();
      try {
        await request('GET', '/customers?limit=1');
        return { ok: true, latencyMs: Date.now() - t0 };
      } catch {
        return { ok: false, latencyMs: Date.now() - t0 };
      }
    },
  };
}
