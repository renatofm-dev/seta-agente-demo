import { type DestinationStream, type Logger, type LoggerOptions, pino } from 'pino';
import { v7 as uuidv7 } from 'uuid';

/**
 * Logging estruturado do produto: pino + traceId UUIDv7 em todo log de turno/request.
 * Métricas e trace de turno completos chegam na spec 010.
 */

export function newTraceId(): string {
  return uuidv7();
}

export interface CreateLoggerOptions {
  readonly name: string;
  readonly level?: string;
}

export function createLogger(
  opts: CreateLoggerOptions,
  pinoOptions: LoggerOptions = {},
  destination?: DestinationStream,
): Logger {
  const options: LoggerOptions = {
    name: opts.name,
    level: opts.level ?? 'info',
    ...pinoOptions,
  };
  return destination ? pino(options, destination) : pino(options);
}

export {
  createNoopObsEmitter,
  type EventoEscalonamento,
  EventoEscalonamentoSchema,
  type EventoGuardrail,
  EventoGuardrailSchema,
  type EventoLlm,
  EventoLlmSchema,
  type ObsEmitter,
} from './emitter.js';
