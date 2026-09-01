import { ALLOW, type GuardrailCtx, type GuardrailHooks, type Verdict } from './index.js';

/**
 * Guardrail de preço/valores (o guardrail da demo):
 * - estrutural: nenhuma tool cota valor livre — no domínio 012 nenhuma entrada
 *   é price_source; todo dinheiro sai de colunas monetárias das tools;
 * - beforeReply: todo valor monetário do draft precisa ser rastreável a um
 *   resultado de tool DESTE turno; valor órfão, percentual de desconto ou
 *   promessa de condição especial → escalate(negociacao_preco).
 */

// milhar exige ≥1 ponto; senão `\d{1,3}` casaria só o prefixo de "2854,30"
const RE_REAIS = /R\$\s?(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{2}))?/g;
// #34: LLM varia a grafia — "1234 reais" / "12,50 real" também é valor
// (número por extenso, ex. "mil e duzentos reais", fica fora — premissa)
const RE_REAIS_SUFIXO = /\b(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{2}))?\s*(?:reais|real)\b/gi;
const RE_PERCENTUAL = /\d+(?:[.,]\d+)?\s?(?:%|por\s?cento)/gi;
const RE_CONDICAO_ESPECIAL =
  /\b(desconto|abatimento|cortesia|por conta da casa|pre[cç]o especial|condi[cç][aã]o especial|baixar o pre[cç]o|fa[cç]o por)\b/i;

/** Valores monetários do texto, em centavos. */
export function extrairValoresMonetarios(texto: string): number[] {
  const valores: number[] = [];
  for (const re of [RE_REAIS, RE_REAIS_SUFIXO]) {
    for (const m of texto.matchAll(re)) {
      const inteiros = Number((m[1] ?? '0').replaceAll('.', ''));
      const centavos = Number(m[2] ?? '0');
      valores.push(inteiros * 100 + centavos);
    }
  }
  return valores;
}

/** Coluna que carrega dinheiro (valor_centavos, preco_..., total_...). */
const RE_COLUNA_MONETARIA = /centavos|valor|pre[cç]o|total/i;

/**
 * Valores (centavos) rastreáveis nos resultados de tools do turno. Tool
 * `price_source` legitima qualquer coluna; nas demais, só colunas MONETÁRIAS —
 * id de produto ou quantidade não pode validar um "R$" do draft (spec 006).
 */
function valoresRastreaveis(ctx: GuardrailCtx): Set<number> {
  const set = new Set<number>();
  for (const r of ctx.toolResults) {
    for (const row of r.rows) {
      for (const [coluna, valor] of Object.entries(row)) {
        if (!r.priceSource && !RE_COLUNA_MONETARIA.test(coluna)) continue;
        const n = typeof valor === 'string' ? Number(valor) : valor;
        if (typeof n === 'number' && Number.isFinite(n) && Number.isInteger(n)) set.add(n);
      }
    }
  }
  return set;
}

export function guardrailPreco(): GuardrailHooks {
  return {
    nome: 'preco',
    async beforeReply(draft, ctx): Promise<Verdict> {
      if (RE_CONDICAO_ESPECIAL.test(draft)) {
        return {
          tipo: 'escalate',
          trigger: 'negociacao_preco',
          reason: 'draft promete desconto/condição especial — agente não negocia preço',
        };
      }
      const percentuais = draft.match(RE_PERCENTUAL);
      if (percentuais && percentuais.length > 0) {
        return {
          tipo: 'escalate',
          trigger: 'negociacao_preco',
          reason: `draft contém percentual (${percentuais[0]}) — cheiro de negociação`,
        };
      }
      const valores = extrairValoresMonetarios(draft);
      if (valores.length === 0) return ALLOW;
      const rastreaveis = valoresRastreaveis(ctx);
      const orfaos = valores.filter((v) => !rastreaveis.has(v));
      if (orfaos.length > 0) {
        return {
          tipo: 'escalate',
          trigger: 'negociacao_preco',
          reason: `valor monetário sem origem em tool do turno: R$ ${(orfaos[0] ?? 0) / 100}`,
        };
      }
      return ALLOW;
    },
  };
}
