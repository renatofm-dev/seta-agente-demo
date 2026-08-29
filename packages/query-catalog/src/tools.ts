import { z } from 'zod';
import type { Executor, RunResult, SessionCtx } from './executor.js';
import type { CatalogIndex } from './loader.js';
import { zodDoParam } from './schema.js';

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
   * Spec 003 (#35): tools de dado só aparecem COM vínculo contato↔cliente na
   * sessão — sem vínculo o modelo nem as vê (em vez de colher erros).
   * Ausente ⇒ true (compatibilidade com chamadas existentes).
   */
  readonly temVinculo?: boolean;
}

export function buildToolSpecs(
  catalog: CatalogIndex,
  executor: Executor,
  opts: BuildToolSpecsOptions,
): ToolSpec[] {
  if (opts.temVinculo === false) return [];
  return catalog
    .list()
    .filter((entry) => entry.tool.expose)
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
      return {
        name: entry.tool.name,
        entryId: entry.id,
        description: entry.description,
        schema: z.object(shape),
        priceSource: entry.price_source,
        async execute(rawParams, session) {
          if (!session.clienteId) {
            throw new Error('sessão sem vínculo contato↔cliente — tool indisponível');
          }
          return executor.run(entry.id, rawParams, session);
        },
      };
    });
}
