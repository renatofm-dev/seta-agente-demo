import { ALLOW, type GuardrailCtx, type GuardrailHooks, type Verdict } from './index.js';

/**
 * 015c — percentual na raia do SDR, inclusive POR EXTENSO.
 *
 * `preco.ts` já barra percentual, mas só com dígito: `RE_PERCENTUAL` exige
 * `\d+`, então "aplico **três** por cento" passa em qualquer contexto. A lacuna
 * está travada em teste desde a 006 (`guardrails.test.ts`, caso "LACUNA").
 *
 * Na raia do cotista isso quase não expõe nada — o classificador de intenção
 * pega "negociar_preco" antes de o agente responder. **Na raia do SDR, que
 * negocia por ofício, é exposição real**: o agente comercial nunca pode falar
 * em percentual, só em valor. Um "consigo três por cento" dito ao lead é uma
 * promessa que ninguém autorizou e que o piso da alçada não controla.
 *
 * Por que um hook PRÓPRIO e não um ajuste no `RE_PERCENTUAL`: mexer no regex
 * mudaria a raia do cotista junto, e o teste que documenta a lacuna lá é
 * deliberado (a 006 decidiu conviver com ela). Este hook entra só na raia SDR;
 * `preco.ts` fica intocado e seu teste continua valendo como está.
 */

/** Números por extenso de um a cem — o que cabe numa oferta de verdade. */
const UNIDADES =
  'um|uma|dois|duas|tr[eê]s|quatro|cinco|seis|sete|oito|nove|dez|onze|doze|treze|catorze|quatorze|quinze|dezesseis|dezessete|dezoito|dezenove';
const DEZENAS = 'vinte|trinta|quarenta|cinquenta|sessenta|setenta|oitenta|noventa|cem|cento';
const FRACAO = 'meio|meia';

/**
 * "três por cento", "dez porcento", "vinte e cinco por cento", "meio por cento",
 * "dois e meio por cento". O dígito também casa — este hook cobre as duas
 * formas para não depender da ordem dos guardrails no pipeline.
 */
export const RE_PERCENTUAL_EXTENSO = new RegExp(
  `\\b(?:\\d+(?:[.,]\\d+)?|${UNIDADES}|${DEZENAS}|${FRACAO})` +
    `(?:\\s+e\\s+(?:${UNIDADES}|${FRACAO}))?\\s*(?:%|por\\s?cento)`,
  'i',
);

/**
 * Vocabulário comercial proibido na raia SDR — aqui é ABSOLUTO, diferente de
 * `preco.ts`, onde o termo órfão só é suspeito se não vier de tool. O SDR não
 * tem KB de política de trocas para citar: se ele escreveu "desconto", foi ele
 * que inventou.
 */
export const VOCABULARIO_PROIBIDO_SDR: readonly string[] = [
  'desconto',
  'abatimento',
  'cortesia',
  'preço especial',
  'preco especial',
  'condição especial',
  'condicao especial',
  'baixar o preço',
  'baixar o preco',
  'faço por',
  'faco por',
];

const RE_VOCABULARIO = new RegExp(
  `\\b(?:${VOCABULARIO_PROIBIDO_SDR.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
  'i',
);

/** Coluna que carrega o piso da alçada nas tools comerciais. */
const RE_COLUNA_PISO = /valor_minimo_centavos/i;

/** O piso vindo de uma tool DESTE turno — base do rewrite. */
function pisoDoTurno(ctx: GuardrailCtx): number | null {
  for (const r of ctx.toolResults) {
    for (const row of r.rows) {
      for (const [coluna, valor] of Object.entries(row)) {
        if (!RE_COLUNA_PISO.test(coluna)) continue;
        const n = typeof valor === 'string' ? Number(valor) : valor;
        if (typeof n === 'number' && Number.isFinite(n) && n > 0) return Math.round(n);
      }
    }
  }
  return null;
}

function reais(centavos: number): string {
  const inteiros = Math.floor(centavos / 100);
  const resto = centavos % 100;
  const milhar = inteiros.toString().replaceAll(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `R$ ${milhar},${resto.toString().padStart(2, '0')}`;
}

/**
 * O mesmo trigger da 015a (`desconto_acima_alcada`) de propósito: o console e o
 * relatório de escalonamento por motivo não ganham uma categoria nova para o
 * que, do ponto de vista da operação, é a mesma coisa — o agente tentou
 * negociar fora da alçada.
 */
export const TRIGGER_PERCENTUAL_SDR = 'desconto_acima_alcada';

export function guardrailPercentualSdr(): GuardrailHooks {
  return {
    nome: 'percentual_sdr',

    async beforeReply(draft: string, ctx: GuardrailCtx): Promise<Verdict> {
      const temPercentual = RE_PERCENTUAL_EXTENSO.test(draft);
      const temVocabulario = RE_VOCABULARIO.test(draft);
      if (!temPercentual && !temVocabulario) return ALLOW;

      /**
       * `rewrite` só quando dá para dizer a mesma coisa com um valor que veio
       * de tool NESTE turno. Sem o piso à mão, reescrever significaria inventar
       * número — então escala e um humano resolve.
       */
      const piso = pisoDoTurno(ctx);
      if (piso !== null && temPercentual) {
        return {
          tipo: 'rewrite',
          patch: `Consigo fechar em ${reais(piso)} à vista. Fechamos assim?`,
        };
      }
      return {
        tipo: 'escalate',
        trigger: TRIGGER_PERCENTUAL_SDR,
        reason: temPercentual
          ? 'rascunho do SDR fala em percentual — a raia comercial só fala em valor'
          : 'rascunho do SDR usa vocabulário de desconto sem valor de tool no turno',
      };
    },
  };
}
