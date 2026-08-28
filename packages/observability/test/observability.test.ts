import { Writable } from 'node:stream';
import { createLogger, newTraceId } from '@seta/observability';
import { describe, expect, it } from 'vitest';

describe('observability', () => {
  it('newTraceId gera UUIDv7 (nibble de versão = 7)', () => {
    const id = newTraceId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('traceIds são ordenáveis no tempo (prefixo timestamp do v7)', () => {
    const a = newTraceId();
    const b = newTraceId();
    expect(a <= b).toBe(true);
  });

  it('logger emite JSON estruturado com name, level e traceId', () => {
    const linhas: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        linhas.push(String(chunk));
        cb();
      },
    });
    const log = createLogger({ name: 'teste', level: 'debug' }, {}, sink);
    const traceId = newTraceId();
    log.info({ traceId }, 'evento');

    expect(linhas).toHaveLength(1);
    const json = JSON.parse(linhas[0] ?? '{}');
    expect(json.name).toBe('teste');
    expect(json.msg).toBe('evento');
    expect(json.traceId).toBe(traceId);
  });
});

describe('ObsEmitter (010)', () => {
  const base = {
    traceId: 'abc',
    conversaId: '018f4d5e-7b7a-7000-8000-000000000001',
  };

  it('EventoLlmSchema valida e aplica defaults de turno/ticket', async () => {
    const { EventoLlmSchema } = await import('../src/emitter.js');
    const e = EventoLlmSchema.parse({
      ...base,
      modelo: 'gpt-x',
      tokensEntrada: 100,
      tokensSaida: 20,
      latenciaMs: 300,
    });
    expect(e.turnoId).toBeNull();
    expect(e.ticketId).toBeNull();
  });

  it('EventoGuardrailSchema restringe hook e verdict', async () => {
    const { EventoGuardrailSchema } = await import('../src/emitter.js');
    expect(() =>
      EventoGuardrailSchema.parse({
        ...base,
        guardrail: 'preco',
        hook: 'aposTudo',
        verdict: 'allow',
      }),
    ).toThrow();
  });

  it('emissor noop não lança e não faz nada', async () => {
    const { createNoopObsEmitter, EventoEscalonamentoSchema } = await import('../src/emitter.js');
    const emitter = createNoopObsEmitter();
    emitter.escalonamento(
      EventoEscalonamentoSchema.parse({ ...base, motivo: 'negociacao_preco', origem: 'guardrail' }),
    );
  });
});
