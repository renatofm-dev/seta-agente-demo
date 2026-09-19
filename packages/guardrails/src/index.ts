import { z } from 'zod';

/**
 * Guardrails (006): políticas por ARQUITETURA — pipeline de hooks verificáveis
 * sobre o turno, não instrução textual. Todo verdict != allow entra no trace
 * e vira sinal_aprendizado (009).
 */

export const VerdictSchema = z.discriminatedUnion('tipo', [
  z.object({ tipo: z.literal('allow') }),
  z.object({ tipo: z.literal('rewrite'), patch: z.string().min(1) }),
  z.object({ tipo: z.literal('block'), reason: z.string().min(1) }),
  z.object({
    tipo: z.literal('escalate'),
    trigger: z.string().min(1),
    reason: z.string().optional(),
  }),
]);
export type Verdict = z.infer<typeof VerdictSchema>;

export const ALLOW: Verdict = { tipo: 'allow' };

/** Resultado de tool do turno, visível aos hooks (já mascarado pelo executor). */
export interface ToolResultTurno {
  readonly nome: string;
  readonly priceSource: boolean;
  readonly rows: readonly Record<string, unknown>[];
  readonly erro?: string;
}

export interface GuardrailCtx {
  readonly traceId: string;
  readonly textoUsuario: string;
  readonly toolResults: readonly ToolResultTurno[];
}

export interface GuardrailHooks {
  readonly nome: string;
  beforeTool?(
    call: { nome: string; params: Record<string, unknown> },
    ctx: GuardrailCtx,
  ): Promise<Verdict>;
  afterTool?(result: ToolResultTurno, ctx: GuardrailCtx): Promise<Verdict>;
  beforeReply?(draft: string, ctx: GuardrailCtx): Promise<Verdict>;
}

export interface VerdictRegistrado {
  readonly guardrail: string;
  readonly hook: 'beforeTool' | 'afterTool' | 'beforeReply';
  readonly verdict: Verdict;
}

export interface ResultadoPipeline {
  /** Draft final (após rewrites), quando o pipeline permite responder. */
  readonly draft: string;
  /** Primeiro verdict terminal (block/escalate), se houve. */
  readonly terminal: Extract<Verdict, { tipo: 'block' | 'escalate' }> | null;
  /** Todos os verdicts emitidos (inclusive rewrites), na ordem. */
  readonly verdicts: readonly VerdictRegistrado[];
}

/**
 * Roda os hooks beforeReply em ordem: rewrite substitui o draft e continua;
 * block/escalate encerra o pipeline.
 */
export async function runBeforeReply(
  hooks: readonly GuardrailHooks[],
  draftInicial: string,
  ctx: GuardrailCtx,
): Promise<ResultadoPipeline> {
  const verdicts: VerdictRegistrado[] = [];
  let draft = draftInicial;
  for (const hook of hooks) {
    if (!hook.beforeReply) continue;
    const v = await hook.beforeReply(draft, ctx);
    if (v.tipo === 'allow') continue;
    verdicts.push({ guardrail: hook.nome, hook: 'beforeReply', verdict: v });
    if (v.tipo === 'rewrite') {
      draft = v.patch;
      continue;
    }
    return { draft, terminal: v, verdicts };
  }
  return { draft, terminal: null, verdicts };
}

/** Mesmo contrato para os pontos beforeTool/afterTool (primeiro != allow vence). */
export async function runToolHooks(
  hooks: readonly GuardrailHooks[],
  ponto: 'beforeTool' | 'afterTool',
  arg: { nome: string; params: Record<string, unknown> } | ToolResultTurno,
  ctx: GuardrailCtx,
): Promise<{
  terminal: Extract<Verdict, { tipo: 'block' | 'escalate' }> | null;
  verdicts: VerdictRegistrado[];
}> {
  const verdicts: VerdictRegistrado[] = [];
  for (const hook of hooks) {
    const fn = ponto === 'beforeTool' ? hook.beforeTool : hook.afterTool;
    if (!fn) continue;
    // biome-ignore lint/suspicious/noExplicitAny: união estreitada pelo ponto
    const v = await fn.call(hook, arg as any, ctx);
    if (v.tipo === 'allow') continue;
    verdicts.push({ guardrail: hook.nome, hook: ponto, verdict: v });
    if (v.tipo === 'block' || v.tipo === 'escalate') return { terminal: v, verdicts };
  }
  return { terminal: null, verdicts };
}

export {
  classificarIntencao,
  INTENCOES,
  type Intencao,
  type IntencaoQueEscala,
  intencaoEscala,
  TRIGGER_POR_INTENCAO,
} from './intencao.js';
export { extrairValoresMonetarios, guardrailPreco } from './preco.js';
export {
  guardrailPercentualSdr,
  RE_PERCENTUAL_EXTENSO,
  TRIGGER_PERCENTUAL_SDR,
  VOCABULARIO_PROIBIDO_SDR,
} from './sdr-percentual.js';
