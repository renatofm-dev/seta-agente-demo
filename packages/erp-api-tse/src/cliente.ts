import { createHash } from 'node:crypto';
import { ErpBusinessError } from './erros.js';
import { criarHttp, type TseHttpConfig } from './http.js';
import {
  type ApiConnector,
  centavosParaReais,
  type ErpWriter,
  FinanceiroContratoSchema,
  type ParcelaErp,
  paraParcelaErp,
  RegistrarPagamentoInputSchema,
} from './tipos.js';

/**
 * Cliente do TS Explorer (036). Duas operações, e a segunda existe por causa da
 * primeira: registrar a baixa, e reler a parcela para saber se a baixa pegou.
 */

/**
 * `"Transação inserida com sucesso, sob id: 1"` — string, não objeto. A extração
 * é por regex ESTRITA: HTTP 200 não é prova de sucesso nesta API, e qualquer
 * prosa que não case vira erro de negócio, nunca sucesso silencioso.
 */
const ID_DA_PROSA = /sob id:\s*(\d+)/i;

/**
 * Limite de `CodigoAutorizacao` NÃO CONFIRMADO pelo fornecedor (no exemplo da
 * coleção tem 6 caracteres; a coluna do simulador é varchar(40)). Enquanto a
 * resposta não vem, 40 é o teto e o id do PSP passa inteiro — `pay_…` do Asaas
 * tem 18. Se algum dia estourar, vira hash curto determinístico e a
 * correspondência fica em `erp_escrita.payload`, que é quem o financeiro lê.
 */
export const CODIGO_AUTORIZACAO_MAX = 40;

export function codigoAutorizacao(referencia: string, max = CODIGO_AUTORIZACAO_MAX): string {
  if (referencia.length <= max) return referencia;
  return createHash('sha256').update(referencia).digest('hex').slice(0, max);
}

/** Teto de páginas no read-back: contrato da demo tem 110 parcelas (11 páginas). */
const MAX_PAGINAS = 50;

export interface TseErpApi extends ErpWriter {
  /** Exposto para a 037 plugar o catálogo; a 036 não usa de fora. */
  readonly api: ApiConnector;
}

export function createTseErpApi(config: TseHttpConfig): TseErpApi {
  const { api } = criarHttp(config);

  return {
    fornecedor: 'tse',
    api,

    async registrarPagamento(entrada) {
      const i = RegistrarPagamentoInputSchema.parse(entrada);
      /**
       * PREMISSA (registrada no PR da 036, pergunta aberta ao fornecedor):
       * `TransacaoEletronica` é o ÚNICO endpoint de baixa da coleção e o corpo
       * dele é de cartão. Varremos os 90 requests: não há campo de
       * `DataPagamento`/`DataRecebimento`/liquidação em lugar nenhum.
       *
       * Como a plataforma cobra por PIX e boleto (042/043), mandamos os campos
       * de cartão NULOS e o id da cobrança no PSP em `CodigoAutorizacao` — que
       * dá ao financeiro do cliente o link com o extrato do gateway e é o que
       * o read-back usa para reconhecer a própria baixa.
       *
       * Não inventamos endpoint nem campo: só o que a coleção tem. Se a resposta
       * do fornecedor for outra, muda ESTA função e mais nada.
       */
      const { json } = await api.request({
        method: 'POST',
        path: '/api/financeiro/TransacaoEletronica',
        body: {
          IdContaFinanceira: Number(i.contaFinanceiraId),
          Valor: centavosParaReais(i.valorCentavos),
          QuatroPrimeirosDigitosCartao: i.quatroPrimeiros ?? null,
          QuatroUltimosDigitosCartao: i.quatroUltimos ?? null,
          CodigoAutorizacao: codigoAutorizacao(i.referenciaPsp),
          QuantidadeParcelas: i.parcelas,
          NomePessoa: i.pagadorNome ?? null,
        },
      });
      const prosa = typeof json === 'string' ? json : JSON.stringify(json);
      const casou = ID_DA_PROSA.exec(prosa);
      if (!casou?.[1]) {
        throw new ErpBusinessError(
          `TSE respondeu 200 sem id de transação: ${prosa.slice(0, 200)}`,
          200,
          prosa,
        );
      }
      return { transacaoId: casou[1] };
    },

    async lerParcela(contaFinanceiraId, contratoId) {
      // o painel pagina de 10 em 10 e não filtra por parcela: varre até achar
      for (let pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
        const { json } = await api.request({
          method: 'GET',
          path: '/api/PainelDoCliente/FinanceiroContrato',
          query: { idContrato: contratoId, paginaAtual: pagina },
        });
        const envelope = FinanceiroContratoSchema.parse(json);
        const achada = envelope.ListaDados.find(
          (p) => String(p.Identificador) === contaFinanceiraId,
        );
        if (achada) return paraParcelaErp(achada);
        if (pagina >= envelope.TotalPaginas) return null;
      }
      return null;
    },

    health: () => api.health(),
  } satisfies TseErpApi as TseErpApi;
}

export type { ParcelaErp };
