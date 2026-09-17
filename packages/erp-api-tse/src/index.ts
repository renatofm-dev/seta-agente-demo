/**
 * Port de ESCRITA no ERP e cliente da API do TS Explorer (036).
 *
 * O port (`ErpWriter`) expõe interface; `createTseErpApi` e `createErpSimulado`
 * são implementações, e quem consome nunca deve depender de qual das duas está
 * de pé — é o mesmo desenho de `AIProvider`, `DbConnector` e `PaymentProvider`.
 */
export {
  CODIGO_AUTORIZACAO_MAX,
  codigoAutorizacao,
  createTseErpApi,
  type TseErpApi,
} from './cliente.js';
export {
  ErpAuthError,
  ErpBusinessError,
  ErpError,
  ErpUnavailableError,
  erroDeResposta,
  redigir,
} from './erros.js';
export { criarHttp, type TseHttpConfig } from './http.js';
export {
  type CriarUtilizacaoInput,
  CriarUtilizacaoInputSchema,
  type DiariaSimulada,
  diaDe,
  type HospedeInput,
  HospedeInputSchema,
  mesmaReserva,
  type OpcaoErp,
  paraSimulacao,
  paraUtilizacao,
  type SimulacaoErp,
  type SimularUtilizacaoInput,
  SimularUtilizacaoInputSchema,
  type UtilizacaoErp,
} from './reserva.js';
export { createErpSimulado, type ErpSimulado } from './simulado.js';
export {
  type ApiConnector,
  centavosParaReais,
  type ErpWriter,
  MEIO_PAGAMENTO_TSE,
  METODOS,
  type Metodo,
  type ParcelaErp,
  paraParcelaErp,
  type RegistrarPagamentoInput,
  RegistrarPagamentoInputSchema,
  reaisParaCentavos,
} from './tipos.js';
export { criarTokenStore, type TokenConfig, type TokenStore } from './token.js';
