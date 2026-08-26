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
