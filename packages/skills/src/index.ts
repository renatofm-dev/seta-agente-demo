import { z } from 'zod';
import type { SkillDoc } from './skill-md.js';

/**
 * Port SkillRegistry (009): skills versionados com aprovação humana.
 * Implementação (drizzle) vive no server; quem consome vê só a interface.
 */

export const SKILL_VERSAO_STATUS = [
  'proposta',
  'em_revisao',
  'ativa',
  'arquivada',
  'rejeitada',
] as const;
export const SkillVersaoStatusSchema = z.enum(SKILL_VERSAO_STATUS);
export type SkillVersaoStatus = z.infer<typeof SkillVersaoStatusSchema>;

export const PROPOSTA_TIPOS = [
  'skill_novo',
  'skill_patch',
  'exemplar',
  'lacuna_kb',
  'lacuna_catalogo',
] as const;
export const PropostaTipoSchema = z.enum(PROPOSTA_TIPOS);
export type PropostaTipo = z.infer<typeof PropostaTipoSchema>;

export interface SkillAtiva {
  readonly skillId: string;
  readonly idLogico: string;
  readonly versaoId: string;
  readonly versao: number;
  readonly doc: SkillDoc;
  /** Score de retrieval (similaridade + boost por métrica). */
  readonly score: number;
}

export interface RetrievalCtx {
  readonly texto: string;
  /** Embedding do texto do turno, quando o provider tem EMBEDDING_MODEL. */
  readonly embedding?: readonly number[];
}

export interface SkillRegistry {
  /** Top-k skills ativas para o contexto (retrieval semântico + boost por métrica). */
  activeFor(ctx: RetrievalCtx, k: number): Promise<SkillAtiva[]>;
  /** Aprova a proposta criando versão IMUTÁVEL (edits ⇒ novo conteúdo, nova versão). */
  approve(
    propostaId: string,
    revisor: string,
    edits?: { corpo?: string },
  ): Promise<{ versaoId: string }>;
  /** Rejeita a proposta; o motivo vira sinal_aprendizado. */
  reject(propostaId: string, revisor: string, motivo: string): Promise<void>;
  /** Reativa uma versão anterior (a atual vai para arquivada). */
  rollback(skillId: string, paraVersao: number, motivo: string): Promise<void>;
  /** Kill-switch: remove do retrieval imediatamente. */
  deactivate(skillId: string, motivo: string): Promise<void>;
}

/** Similaridade de cosseno (embeddings em JS — POC com poucas skills). */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Fallback sem embeddings: sobreposição de termos (gatilho+descrição × texto). */
export function overlapTermos(texto: string, referencia: string): number {
  const tokens = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .normalize('NFD')
        .replaceAll(/[̀-ͯ]/g, '')
        .split(/\W+/)
        .filter((t) => t.length > 3),
    );
  const a = tokens(texto);
  const b = tokens(referencia);
  if (b.size === 0) return 0;
  let comum = 0;
  for (const t of a) if (b.has(t)) comum += 1;
  return comum / b.size;
}

export { DISTILLER_OUTPUT_SCHEMA, renderPromptDistiller } from './distiller-prompt.js';
export {
  parseSkillMd,
  type SkillDoc,
  type SkillFrontmatter,
  SkillFrontmatterSchema,
  serializeSkillMd,
  XSetaSchema,
} from './skill-md.js';
