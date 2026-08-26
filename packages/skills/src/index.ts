import { z } from 'zod';

/**
 * Port SkillRegistry: skills versionados com aprovação humana.
 * Distiller, curadoria e rollback chegam na spec 009.
 */

export const SKILL_STATUS = ['proposto', 'aprovado', 'desativado'] as const;
export const SkillStatusSchema = z.enum(SKILL_STATUS);
export type SkillStatus = z.infer<typeof SkillStatusSchema>;

export const SkillMetaSchema = z.object({
  id: z.uuid(),
  nome: z.string().min(1),
  versao: z.number().int().min(1),
  status: SkillStatusSchema,
});
export type SkillMeta = z.infer<typeof SkillMetaSchema>;

export interface SkillRegistry {
  listar(status?: SkillStatus): Promise<readonly SkillMeta[]>;
  obterConteudo(id: string, versao: number): Promise<string>;
}
