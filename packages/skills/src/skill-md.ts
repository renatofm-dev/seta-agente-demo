import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';

/**
 * Formato SKILL.md (009): markdown com frontmatter compatível agentskills.io
 * + bloco `x-seta` (escopo, gatilho, tools, métricas, proveniência).
 */

export const XSetaSchema = z.object({
  escopo: z.literal('local'), // multi-implantação/frota está fora da POC (000)
  gatilho: z.string().min(5),
  tools: z.array(z.string().min(1)).default([]),
  metricas: z
    .object({
      usos: z.number().int().min(0).default(0),
      resolucoes: z.number().int().min(0).default(0),
    })
    .default({ usos: 0, resolucoes: 0 }),
  proveniencia: z.enum(['distiller', 'humano']),
});

export const SkillFrontmatterSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, 'name deve ser kebab-case (id lógico do skill)'),
  description: z.string().min(10),
  'x-seta': XSetaSchema,
});
export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

export interface SkillDoc {
  readonly frontmatter: SkillFrontmatter;
  readonly corpo: string;
}

const RE_FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseSkillMd(conteudo: string): SkillDoc {
  const m = conteudo.match(RE_FRONTMATTER);
  if (!m) throw new Error('SKILL.md sem frontmatter (--- ... ---)');
  const frontmatter = SkillFrontmatterSchema.parse(parseYaml(m[1] ?? ''));
  const corpo = (m[2] ?? '').trim();
  if (corpo.length < 20) throw new Error('SKILL.md com corpo vazio ou curto demais');
  return { frontmatter, corpo };
}

export function serializeSkillMd(doc: SkillDoc): string {
  return `---\n${stringifyYaml(doc.frontmatter).trim()}\n---\n\n${doc.corpo.trim()}\n`;
}
