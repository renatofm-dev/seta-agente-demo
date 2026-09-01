import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClientConfigSchema, loadClientConfig } from '@seta/client-config';
import { describe, expect, it } from 'vitest';

const configDemo = join(import.meta.dirname, '../../../configs/demo/client.yaml');

describe('client-config', () => {
  it('valida o client.yaml da demo (o arquivo real do repo)', () => {
    const cfg = loadClientConfig(configDemo);
    expect(cfg.nome).toBe('Mirante da Serra Resort');
    expect(cfg.modulos.financeiro).toBe(true);
    expect(cfg.modulos.contrato).toBe(true);
    expect(cfg.limites.maxToolCallsPorTurno).toBeGreaterThan(0);
  });

  it('rejeita config sem persona ou com limite fora da faixa', () => {
    expect(
      ClientConfigSchema.safeParse({
        nome: 'X',
        modulos: { financeiro: true, contrato: true, atendimento: true },
        limites: { maxToolCallsPorTurno: 5, maxMensagensContexto: 30, maxCaracteresResposta: 2000 },
      }).success,
    ).toBe(false);
    expect(
      ClientConfigSchema.safeParse({
        nome: 'X',
        persona: 'p',
        modulos: { financeiro: true, contrato: true, atendimento: true },
        limites: { maxToolCallsPorTurno: 0, maxMensagensContexto: 30, maxCaracteresResposta: 2000 },
      }).success,
    ).toBe(false);
  });

  it('YAML malformado lança erro no load', () => {
    const dir = mkdtempSync(join(tmpdir(), 'seta-cfg-'));
    const arquivo = join(dir, 'quebrado.yaml');
    writeFileSync(arquivo, 'nome: [aberto\npersona: "x');
    expect(() => loadClientConfig(arquivo)).toThrow();
  });
});
