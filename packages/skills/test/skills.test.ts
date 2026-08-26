import { SkillMetaSchema } from '@seta/skills';
import { describe, expect, it } from 'vitest';

describe('skills (port)', () => {
  const base = {
    id: '01890a5d-ac96-774b-bcce-b302099a8057',
    nome: 'responder-boletos-em-aberto',
    versao: 1,
    status: 'proposto',
  };

  it('aceita meta de skill válida', () => {
    expect(SkillMetaSchema.safeParse(base).success).toBe(true);
  });

  it('rejeita versão zero/negativa e status desconhecido', () => {
    expect(SkillMetaSchema.safeParse({ ...base, versao: 0 }).success).toBe(false);
    expect(SkillMetaSchema.safeParse({ ...base, status: 'publicado' }).success).toBe(false);
  });
});
