import {
  ClienteInputSchema,
  CobrancaInputSchema,
  type CobrancaPsp,
  type PaymentProvider,
} from './tipos.js';

/**
 * PSP simulado (dev sem Asaas e testes): ids determinísticos, links e códigos
 * fictícios, tudo em memória. Aplica as MESMAS validações Zod do adapter real
 * para o comportamento não divergir. `simularRecebimento` só muda o status —
 * quem injeta o evento no caminho do webhook é a dev-route do server.
 */

export interface SimulatedPaymentProvider extends PaymentProvider {
  readonly cobrancas: ReadonlyMap<string, CobrancaPsp>;
  /** Contadores para asserts de idempotência nos testes. */
  readonly chamadas: { criarCobranca: number; garantirCliente: number };
  /** Reposiciona uma cobrança (ex.: simular vencida/estornada). */
  definirStatus(id: string, status: CobrancaPsp['status']): void;
}

function linhaDigitavelFake(seq: number, centavos: number): string {
  // 47 dígitos, determinística: prefixo fixo + seq + valor com zeros à esquerda
  const corpo = `${String(seq).padStart(25, '0')}${String(centavos).padStart(10, '0')}`;
  return `23790${corpo}`.slice(0, 47).padEnd(47, '0');
}

function pixFake(id: string, centavos: number): string {
  const valor = (centavos / 100).toFixed(2);
  return (
    `00020126580014br.gov.bcb.pix0136${id.padEnd(36, '0').slice(0, 36)}` +
    `52040000530398654${String(valor.length).padStart(2, '0')}${valor}5802BR5913SETA SIMULADO6009SAO PAULO62070503***6304ABCD`
  );
}

export function createSimulatedPaymentProvider(): SimulatedPaymentProvider {
  const cobrancas = new Map<string, CobrancaPsp>();
  const clientes = new Map<string, string>(); // referenciaExterna|documento → id
  let seqCliente = 0;
  let seqCobranca = 0;
  const chamadas = { criarCobranca: 0, garantirCliente: 0 };

  return {
    nome: 'simulado',
    ambiente: 'simulado',
    cobrancas,
    chamadas,

    definirStatus(id, status) {
      const atual = cobrancas.get(id);
      if (!atual) throw new Error(`cobrança simulada ${id} não existe`);
      cobrancas.set(id, { ...atual, status, statusBruto: status.toUpperCase() });
    },

    async garantirCliente(input) {
      const c = ClienteInputSchema.parse(input);
      chamadas.garantirCliente += 1;
      const existente = clientes.get(c.referenciaExterna) ?? clientes.get(c.documento);
      if (existente) return { id: existente };
      seqCliente += 1;
      const id = `sim_cus_${seqCliente}`;
      clientes.set(c.referenciaExterna, id);
      clientes.set(c.documento, id);
      return { id };
    },

    async criarCobranca(input) {
      const c = CobrancaInputSchema.parse(input);
      chamadas.criarCobranca += 1;
      seqCobranca += 1;
      const id = `sim_pay_${seqCobranca}`;
      const cobranca: CobrancaPsp = {
        id,
        status: 'pendente',
        statusBruto: 'PENDING',
        valorCentavos: c.valorCentavos,
        vencimento: c.vencimento,
        urlFatura: `https://pagamento.simulado/p/${id}`,
        urlBoleto: c.metodo === 'boleto' ? `https://pagamento.simulado/b/${id}.pdf` : null,
        referenciaExterna: c.referenciaExterna,
      };
      cobrancas.set(id, cobranca);
      return cobranca;
    },

    async buscarPorReferencia(referenciaExterna) {
      const todas = [...cobrancas.values()].filter(
        (c) => c.referenciaExterna === referenciaExterna,
      );
      return (
        todas.find((c) => c.status === 'pendente' || c.status === 'vencida') ??
        todas.find((c) => c.status === 'recebida' || c.status === 'confirmada') ??
        todas[0] ??
        null
      );
    },

    async cancelarCobranca(id) {
      const atual = cobrancas.get(id);
      if (atual) cobrancas.set(id, { ...atual, status: 'cancelada', statusBruto: 'DELETED' });
    },

    async obterPix(id) {
      const c = cobrancas.get(id);
      if (!c) throw new Error(`cobrança simulada ${id} não existe`);
      return { payload: pixFake(id, c.valorCentavos), expiraEm: `${c.vencimento} 23:59:59` };
    },

    async obterLinhaDigitavel(id) {
      const c = cobrancas.get(id);
      if (!c) throw new Error(`cobrança simulada ${id} não existe`);
      return {
        linhaDigitavel: linhaDigitavelFake(Number(id.replace(/\D/g, '')) || 0, c.valorCentavos),
        codigoBarras: null,
      };
    },

    async simularRecebimento(id) {
      const atual = cobrancas.get(id);
      if (!atual) throw new Error(`cobrança simulada ${id} não existe`);
      cobrancas.set(id, { ...atual, status: 'recebida', statusBruto: 'RECEIVED_IN_CASH' });
    },

    async health() {
      return { ok: true, latencyMs: 0 };
    },
  };
}
