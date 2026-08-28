import {
  cosine,
  DISTILLER_OUTPUT_SCHEMA,
  overlapTermos,
  parseSkillMd,
  renderPromptDistiller,
  serializeSkillMd,
} from '@seta/skills';
import { describe, expect, it } from 'vitest';

const SKILL_VALIDO = `---
name: cobranca-boletos-vencidos
description: Como conduzir conversa sobre boletos vencidos sem constranger o cliente.
x-seta:
  escopo: local
  gatilho: cliente pergunta sobre boletos vencidos ou cobranca
  tools: [titulos_abertos]
  proveniencia: humano
---

Quando o cliente perguntar sobre boletos vencidos:
1. Consulte titulos_abertos e apresente só os vencidos.
2. Informe valor e linha digitável sem tom de cobrança.
`;

describe('formato SKILL.md', () => {
  it('parseia frontmatter x-seta com defaults', () => {
    const doc = parseSkillMd(SKILL_VALIDO);
    expect(doc.frontmatter.name).toBe('cobranca-boletos-vencidos');
    expect(doc.frontmatter['x-seta'].tools).toEqual(['titulos_abertos']);
    expect(doc.frontmatter['x-seta'].metricas).toEqual({ usos: 0, resolucoes: 0 });
    expect(doc.corpo).toContain('linha digitável');
  });

  it('roundtrip parse→serialize→parse preserva o conteúdo', () => {
    const doc = parseSkillMd(SKILL_VALIDO);
    const doc2 = parseSkillMd(serializeSkillMd(doc));
    expect(doc2).toEqual(doc);
  });

  it('rejeita sem frontmatter, name inválido e corpo curto', () => {
    expect(() => parseSkillMd('# sem frontmatter')).toThrow(/frontmatter/);
    expect(() =>
      parseSkillMd(SKILL_VALIDO.replace('cobranca-boletos-vencidos', 'Nome Ruim')),
    ).toThrow();
    expect(() =>
      parseSkillMd(
        `---\nname: a-b\ndescription: descrição válida aqui\nx-seta:\n  escopo: local\n  gatilho: gatilho válido\n  proveniencia: humano\n---\ncurto`,
      ),
    ).toThrow(/curto/);
  });
});

describe('retrieval helpers', () => {
  it('cosine: idênticos=1, ortogonais=0, dimensões diferentes=0', () => {
    expect(cosine([1, 0, 1], [1, 0, 1])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect(cosine([1, 2], [1, 2, 3])).toBe(0);
  });

  it('overlapTermos ranqueia por termos em comum (sem acentos)', () => {
    const alto = overlapTermos(
      'quais boletos vencidos eu tenho?',
      'cliente pergunta sobre boletos vencidos',
    );
    const baixo = overlapTermos(
      'qual o preço da cerveja?',
      'cliente pergunta sobre boletos vencidos',
    );
    expect(alto).toBeGreaterThan(baixo);
  });
});

describe('prompt do distiller', () => {
  it('injeta sinais e o schema de saída valida', () => {
    const prompt = renderPromptDistiller([{ tipo: 'correcao_hitl', motivo: 'desconto' }]);
    expect(prompt).toContain('correcao_hitl');
    expect(prompt).toContain('JSON válido');

    expect(
      DISTILLER_OUTPUT_SCHEMA.safeParse({
        proposta: {
          name: 'lidar-com-desconto',
          description: 'Como responder pedidos de desconto.',
          gatilho: 'cliente pede desconto',
          tools: [],
          corpo: 'Nunca prometa desconto; explique a tabela e escale para humano.',
        },
      }).success,
    ).toBe(true);
    expect(DISTILLER_OUTPUT_SCHEMA.safeParse({ proposta: null }).success).toBe(true);
    expect(DISTILLER_OUTPUT_SCHEMA.safeParse({}).success).toBe(false);
  });
});
