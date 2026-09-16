import { ErpBusinessError } from './erros.js';
import {
  type ErpWriter,
  type ParcelaErp,
  type RegistrarPagamentoInput,
  RegistrarPagamentoInputSchema,
} from './tipos.js';

/**
 * `ErpWriter` em memória. Duas utilidades:
 *
 *  - **boot sem TSE**: sem `TSE_BASE_URL` o server sobe com este, e a baixa vira
 *    registro local em vez de exceção no worker — o mesmo desenho do PSP
 *    simulado da 014, e o boot loga qual dos dois está ativo;
 *  - **teste unitário** de quem consome o port, sem rede e sem Postgres.
 */

export interface ErpSimulado extends ErpWriter {
  /** Tudo que foi "gravado", para o teste conferir. */
  readonly transacoes: readonly { input: RegistrarPagamentoInput; transacaoId: string }[];
  /** Semeia uma parcela para o read-back encontrar. */
  semear(p: ParcelaErp): void;
}

export function createErpSimulado(): ErpSimulado {
  const transacoes: { input: RegistrarPagamentoInput; transacaoId: string }[] = [];
  const parcelas = new Map<string, ParcelaErp>();
  let seq = 0;

  return {
    fornecedor: 'tse',
    transacoes,

    semear(p) {
      parcelas.set(p.contaFinanceiraId, p);
    },

    async registrarPagamento(entrada) {
      const i = RegistrarPagamentoInputSchema.parse(entrada);
      const atual = parcelas.get(i.contaFinanceiraId);
      if (atual === undefined) {
        throw new ErpBusinessError(
          `parcela ${i.contaFinanceiraId} não existe no ERP simulado`,
          400,
          '',
        );
      }
      seq += 1;
      const transacaoId = String(seq);
      transacoes.push({ input: i, transacaoId });
      // o simulado NÃO recusa baixa repetida: o TSE provavelmente também não, e
      // é justamente isso que o read-back do worker existe para compensar
      parcelas.set(i.contaFinanceiraId, {
        ...atual,
        pago: true,
        pagoEm: new Date().toISOString().slice(0, 10),
      });
      return { transacaoId };
    },

    async lerParcela(contaFinanceiraId) {
      return parcelas.get(contaFinanceiraId) ?? null;
    },

    async health() {
      return { ok: true, latencyMs: 0 };
    },
  };
}
