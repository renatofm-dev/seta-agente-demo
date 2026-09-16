/**
 * Fluxo de reserva de utilização de contrato (038) — domínio PURO.
 * Máquina, parser determinístico, fallback por LLM e textos. Sem banco, sem
 * rede: o server executa os efeitos que a máquina devolve.
 */
export { acaoValida, interpretarResposta } from './interpretar.js';
export {
  apresentarHoteis,
  apresentarSimulacao,
  apresentarTiposUh,
  iniciar,
  transicionar,
} from './maquina.js';
export {
  cpfValido,
  extrairCpf,
  extrairNome,
  extrairPagantes,
  extrairPeriodo,
  normalizar,
  parsearResposta,
} from './parser.js';
export {
  formatarDia,
  formatarPeriodo,
  formatarReais,
  milhar,
  TEXTO_BLOQUEADO,
  TEXTO_CANCELADO,
  TEXTO_CPF_INVALIDO,
  TEXTO_CRIANDO,
  TEXTO_FALHA_RESERVA,
  TEXTO_HOSPEDES_PRONTOS,
  TEXTO_NAO_ENTENDI,
  TEXTO_PAGANTES,
  TEXTO_PERIODO,
  TEXTO_PERIODO_INVALIDO,
  TEXTO_RECUSADA,
  TEXTO_SEM_HOTEIS,
  textoAprovacao,
  textoConfirmacao,
  textoHospedes,
  textoHoteis,
  textoPeriodoBloqueado,
  textoPontosInsuficientes,
  textoReservaConfirmada,
  textoSimulacao,
  textoTiposUh,
} from './render.js';
export {
  type Acao,
  type ContextoFluxo,
  type DiariaReserva,
  EFEITOS,
  type Efeito,
  ENCERRAMENTOS,
  type Encerramento,
  ESTADO_INICIAL,
  type EstadoFluxo,
  ETAPAS,
  type Etapa,
  faltamHospedes,
  type HospedeReserva,
  noites,
  type OpcaoReserva,
  type SimulacaoReserva,
  type Transicao,
} from './tipos.js';
