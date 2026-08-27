export { createAgentRuntime, TEXTO_FALLBACK } from './graph.js';
export { renderPromptBase } from './prompt.js';
export {
  NOME_BUSCAR_CONHECIMENTO,
  NOME_ESCALAR,
  toolBuscarConhecimentoStub,
  toolEscalarParaHumano,
} from './tools-internas.js';
export type {
  AgentRuntime,
  AgentRuntimeDeps,
  GuardrailSaida,
  LimitesTurno,
  ResponderEfeitos,
  ResultadoTurno,
  TraceEvento,
  TurnoInput,
} from './types.js';
