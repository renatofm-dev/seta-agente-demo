import { z } from 'zod';
import type { Executor, RunResult, SessionCtx } from './executor.js';
import type { CatalogIndex } from './loader.js';
import type { CatalogEntry } from './schema.js';
import { zodDoParam } from './schema.js';
import { SESSION_PARAMS_DE_VINCULO } from './validate-sql.js';

/**
 * Codegen de tools: entradas `tool.expose: true` viram ToolSpecs neutros
 * (name, description, schema Zod SÓ com params `source: agent`, execute).
 * A spec 005 converte ToolSpec em tool LangGraph com `tool(fn, {...})` —
 * o catálogo não depende de LangChain.
 */

export interface ToolSpec {
  readonly name: string;
  readonly entryId: string;
  readonly description: string;
  readonly schema: z.ZodObject<Record<string, z.ZodType>>;
  readonly priceSource: boolean;
  execute(rawParams: Record<string, unknown>, session: SessionCtx): Promise<RunResult>;
}

export interface BuildToolSpecsOptions {
  /** Módulos habilitados na config da implantação (client-config). */
  readonly modulosHabilitados: Readonly<Record<string, boolean>>;
  /**
   * Spec 003 (#35): tools grão-contrato só aparecem COM vínculo contato↔cliente
   * na sessão — sem vínculo o modelo nem as vê (em vez de colher erros).
   * 015: o portão é por ESCOPO da entrada, não por vínculo — entradas sem
   * param de sessão de vínculo (estoque, condições de venda) aparecem para o
   * lead frio. Ausente ⇒ true (compatibilidade com chamadas existentes).
   */
  readonly temVinculo?: boolean;
}

/** Entrada que depende de um param de sessão só existente com vínculo (`contrato_id`). */
export function exigeVinculo(entry: Pick<CatalogEntry, 'params'>): boolean {
  return Object.entries(entry.params).some(
    ([nome, spec]) => spec.source === 'session' && SESSION_PARAMS_DE_VINCULO.includes(nome),
  );
}

export function buildToolSpecs(
  catalog: CatalogIndex,
  executor: Executor,
  opts: BuildToolSpecsOptions,
): ToolSpec[] {
  const temVinculo = opts.temVinculo !== false;
  return catalog
    .list()
    .filter((entry) => entry.tool.expose)
    .filter((entry) => temVinculo || !exigeVinculo(entry))
    .filter(
      (entry) =>
        entry.modules.length === 0 ||
        entry.modules.some((m) => opts.modulosHabilitados[m] === true),
    )
    .map((entry) => {
      const shape: Record<string, z.ZodType> = {};
      for (const [nome, spec] of Object.entries(entry.params)) {
        if (spec.source !== 'agent') continue; // params de sessão nunca aparecem para o modelo
        let campo = zodDoParam(spec);
        if (spec.description) campo = campo.describe(spec.description);
        shape[nome] = spec.required && spec.default === undefined ? campo : campo.optional();
      }
      const precisaVinculo = exigeVinculo(entry);
      return {
        name: entry.tool.name,
        entryId: entry.id,
        description: entry.description,
        schema: z.object(shape),
        priceSource: entry.price_source,
        async execute(rawParams, session) {
          if (precisaVinculo && !session.clienteId) {
            throw new Error('sessão sem vínculo contato↔cliente — tool indisponível');
          }
          return executor.run(entry.id, rawParams, session);
        },
      };
    });
}
