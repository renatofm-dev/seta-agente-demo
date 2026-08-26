import { ConnectorConfigSchema, NamedBindsSchema } from '@seta/erp-connector';
import { describe, expect, it } from 'vitest';

describe('erp-connector (port)', () => {
  it('aceita config válida e aplica defaults', () => {
    const cfg = ConnectorConfigSchema.parse({ url: 'postgres://erp_ro:x@localhost:5432/erp_mock' });
    expect(cfg.poolMax).toBe(5);
    expect(cfg.statementTimeoutMs).toBe(5_000);
  });

  it('rejeita url inválida', () => {
    expect(ConnectorConfigSchema.safeParse({ url: 'não é url' }).success).toBe(false);
  });

  it('binds aceitam só escalares com nomes válidos', () => {
    expect(NamedBindsSchema.safeParse({ clienteId: 'abc', limite: 10 }).success).toBe(true);
    expect(NamedBindsSchema.safeParse({ '1injetado': 'x' }).success).toBe(false);
    expect(NamedBindsSchema.safeParse({ obj: { nested: true } }).success).toBe(false);
  });
});
