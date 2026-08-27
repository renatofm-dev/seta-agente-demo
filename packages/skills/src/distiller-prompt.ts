import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** Prompt de destilação versionado em arquivo (packages/skills/prompts/). */

const DIR = dirname(fileURLToPath(import.meta.url));
let cache: string | null = null;

export const DISTILLER_OUTPUT_SCHEMA = z.object({
  proposta: z
    .object({
      name: z.string().regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/),
      description: z.string().min(10),
      gatilho: z.string().min(5),
      tools: z.array(z.string()).default([]),
      corpo: z.string().min(20),
    })
    .nullable(),
});
export type DistillerOutput = z.infer<typeof DISTILLER_OUTPUT_SCHEMA>;

export function renderPromptDistiller(sinais: readonly Record<string, unknown>[]): string {
  if (cache === null) {
    cache = readFileSync(join(DIR, '../prompts/distiller.md'), 'utf-8');
  }
  return cache.replace('{{sinais}}', JSON.stringify(sinais, null, 2));
}
