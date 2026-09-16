import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { cruise, type IReporterOutput } from 'dependency-cruiser';
import { describe, expect, it } from 'vitest';

/**
 * Prova do critério de aceite da spec 001: as regras de fronteira do
 * .dependency-cruiser.cjs REAL disparam quando violadas (fixtures) e
 * a árvore real do repo está limpa.
 */

const require_ = createRequire(import.meta.url);
// biome-ignore lint/suspicious/noExplicitAny: config CJS sem tipos
const config: any = require_('../.dependency-cruiser.cjs');

const RULE_PACKAGES_APPS = 'packages-nao-importam-apps';
const RULE_AGENT_CONNECTOR = 'agent-nao-importa-erp-connector';
const RULE_COBRANCA_CONNECTOR = 'cobranca-nao-importa-erp-connector';
/** 036: as duas fronteiras da escrita no ERP. */
const RULE_AGENT_API = 'agent-nao-importa-erp-api';
const RULE_API_FOLHA = 'erp-api-e-folha';

/** Regra sem fixture é regra não provada — todas as que o spec cobre. */
const REGRAS = [
  RULE_PACKAGES_APPS,
  RULE_AGENT_CONNECTOR,
  RULE_COBRANCA_CONNECTOR,
  RULE_AGENT_API,
  RULE_API_FOLHA,
];

interface Violation {
  readonly rule: { readonly name: string };
  readonly from: string;
  readonly to: string;
}

function violationsOf(r: IReporterOutput): Violation[] {
  const output = typeof r.output === 'string' ? JSON.parse(r.output) : r.output;
  return output.summary.violations as Violation[];
}

describe('fronteiras arquiteturais (dependency-cruiser)', () => {
  it('as regras reais disparam sobre fixtures violadoras', async () => {
    const resultado = await cruise(['packages', 'apps'], {
      ruleSet: { forbidden: config.forbidden },
      validate: true,
      baseDir: fileURLToPath(new URL('./fixtures', import.meta.url)),
    });
    const nomes = violationsOf(resultado).map((v) => v.rule.name);
    for (const regra of REGRAS) expect(nomes, `regra sem fixture: ${regra}`).toContain(regra);
  });

  it('a árvore real do repo não tem violação de fronteira', async () => {
    const resultado = await cruise(['apps', 'packages'], {
      ruleSet: config,
      validate: true,
    });
    const relevantes = violationsOf(resultado).filter((v) => REGRAS.includes(v.rule.name));
    expect(relevantes).toEqual([]);
  });
});
