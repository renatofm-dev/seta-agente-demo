import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import type { ChatMessage, ToolCall, ToolDef } from '@seta/ai-provider';
import type { ToolSpec } from '@seta/query-catalog';
import { z } from 'zod';
import { renderPromptBase } from './prompt.js';
import { NOME_ESCALAR } from './tools-internas.js';
import type {
  AgentRuntime,
  AgentRuntimeDeps,
  ResultadoTurno,
  TraceEvento,
  TurnoInput,
} from './types.js';

/**
 * StateGraph do turno: montar_contexto → agente ⇄ tools → guardrails_saida →
 * responder, com fallback honesto (nunca inventa) em budget/timeout/bloqueio.
 */

export const TEXTO_FALLBACK =
  'Não consegui obter essa informação com segurança agora. Prefiro não arriscar uma ' +
  'resposta errada — quer que eu acione um de nossos atendentes para te ajudar?';

const StateAnnotation = Annotation.Root({
  mensagens: Annotation<ChatMessage[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
  pendingToolCalls: Annotation<ToolCall[]>({ reducer: (_a, b) => b, default: () => [] }),
  toolCallsFeitas: Annotation<number>({ reducer: (_a, b) => b, default: () => 0 }),
  draft: Annotation<string | null>({ reducer: (_a, b) => b, default: () => null }),
  fallbackMotivo: Annotation<string | null>({ reducer: (_a, b) => b, default: () => null }),
  escalado: Annotation<boolean>({ reducer: (a, b) => a || b, default: () => false }),
  eventos: Annotation<TraceEvento[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
  tokensEntrada: Annotation<number>({ reducer: (a, b) => a + b, default: () => 0 }),
  tokensSaida: Annotation<number>({ reducer: (a, b) => a + b, default: () => 0 }),
  respostaFinal: Annotation<string | null>({ reducer: (_a, b) => b, default: () => null }),
});
type State = typeof StateAnnotation.State;

function paraToolDefs(tools: readonly ToolSpec[]): ToolDef[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: z.toJSONSchema(t.schema) as Record<string, unknown>,
  }));
}

export function createAgentRuntime(deps: AgentRuntimeDeps): AgentRuntime {
  const guardrails = deps.guardrails ?? [];

  return {
    async processarTurno(input: TurnoInput): Promise<ResultadoTurno> {
      const inicio = Date.now();
      const deadline = inicio + input.limites.timeoutMs;
      const toolsPorNome = new Map(input.tools.map((t) => [t.name, t]));
      const toolDefs = paraToolDefs(input.tools);

      const montarContexto = async (): Promise<Partial<State>> => {
        const system = renderPromptBase({
          persona: input.persona,
          resumo: input.resumo,
          skills: input.skills,
        });
        return {
          mensagens: [
            { role: 'system', content: system },
            ...input.historico,
            { role: 'user', content: input.textoUsuario },
          ],
          eventos: [
            {
              tipo: 'contexto',
              skillIds: input.skills.map((s) => s.id),
              temResumo: Boolean(input.resumo),
              nMensagensHistorico: input.historico.length,
              tools: input.tools.map((t) => t.name),
            },
          ],
        };
      };

      const agente = async (state: State): Promise<Partial<State>> => {
        if (Date.now() > deadline) {
          return { fallbackMotivo: 'timeout de turno' };
        }
        const res = await deps.provider.chat({ messages: state.mensagens, tools: toolDefs });
        const evento: TraceEvento = {
          tipo: 'llm',
          tokensEntrada: res.tokensEntrada,
          tokensSaida: res.tokensSaida,
          finishReason: res.finishReason,
          toolCalls: res.toolCalls.map((c) => c.name),
        };
        if (res.toolCalls.length > 0) {
          if (state.toolCallsFeitas + res.toolCalls.length > input.limites.maxToolCalls) {
            return {
              eventos: [evento],
              tokensEntrada: res.tokensEntrada,
              tokensSaida: res.tokensSaida,
              fallbackMotivo: `budget de tool calls estourado (${input.limites.maxToolCalls})`,
            };
          }
          return {
            eventos: [evento],
            tokensEntrada: res.tokensEntrada,
            tokensSaida: res.tokensSaida,
            mensagens: [
              { role: 'assistant', content: res.content ?? '', toolCalls: [...res.toolCalls] },
            ],
            pendingToolCalls: [...res.toolCalls],
          };
        }
        return {
          eventos: [evento],
          tokensEntrada: res.tokensEntrada,
          tokensSaida: res.tokensSaida,
          draft: res.content ?? '',
          pendingToolCalls: [],
        };
      };

      const executarTool = async (
        spec: ToolSpec,
        params: Record<string, unknown>,
      ): Promise<{ resultado: unknown; erro?: string }> => {
        let tentativas = 0;
        for (;;) {
          try {
            const r = await spec.execute(params, input.session);
            return { resultado: { rows: r.rows, truncated: r.truncated } };
          } catch (err) {
            tentativas += 1;
            if (tentativas > input.limites.retriesPorTool) {
              return {
                resultado: null,
                erro: err instanceof Error ? err.message : String(err),
              };
            }
          }
        }
      };

      const tools = async (state: State): Promise<Partial<State>> => {
        if (Date.now() > deadline) {
          return { fallbackMotivo: 'timeout de turno', pendingToolCalls: [] };
        }
        const novasMensagens: ChatMessage[] = [];
        const eventos: TraceEvento[] = [];
        let escalado = false;

        for (const call of state.pendingToolCalls) {
          const t0 = Date.now();
          const spec = toolsPorNome.get(call.name);
          let params: Record<string, unknown> = {};
          let corpo: string;
          let erro: string | undefined;

          if (!spec) {
            erro = `tool desconhecida: ${call.name}`;
            corpo = JSON.stringify({ erro });
          } else {
            try {
              params = JSON.parse(call.argumentsJson || '{}') as Record<string, unknown>;
            } catch {
              params = {};
            }
            if (call.name === NOME_ESCALAR) escalado = true;
            const r = await executarTool(spec, params);
            erro = r.erro;
            corpo = erro ? JSON.stringify({ erro }) : JSON.stringify(r.resultado);
          }

          eventos.push({
            tipo: 'tool',
            nome: call.name,
            params,
            resultado: erro ? null : JSON.parse(corpo),
            latencyMs: Date.now() - t0,
            ...(erro ? { erro } : {}),
          });
          novasMensagens.push({ role: 'tool', content: corpo, toolCallId: call.id });
        }
        if (escalado) eventos.push({ tipo: 'escalado' });

        return {
          mensagens: novasMensagens,
          eventos,
          escalado,
          toolCallsFeitas: state.toolCallsFeitas + state.pendingToolCalls.length,
          pendingToolCalls: [],
        };
      };

      const guardrailsSaida = async (state: State): Promise<Partial<State>> => {
        const eventos: TraceEvento[] = [];
        let escalado = false;
        for (const g of guardrails) {
          const verdict = await g.avaliar(state.draft ?? '', { traceId: input.session.traceId });
          eventos.push({
            tipo: 'verdict',
            guardrail: g.nome,
            decisao: verdict.decisao,
            motivo: verdict.motivo,
          });
          if (verdict.decisao !== 'permitir') {
            if (verdict.decisao === 'escalar') escalado = true;
            return {
              eventos,
              escalado,
              fallbackMotivo: `guardrail ${g.nome}: ${verdict.decisao} (${verdict.motivo})`,
            };
          }
        }
        return { eventos };
      };

      const fallback = async (state: State): Promise<Partial<State>> => {
        return {
          eventos: [{ tipo: 'fallback', motivo: state.fallbackMotivo ?? 'desconhecido' }],
          draft: TEXTO_FALLBACK,
        };
      };

      const responder = async (state: State): Promise<Partial<State>> => {
        const texto = state.draft ?? TEXTO_FALLBACK;
        await input.efeitos.gravarResposta(texto, {
          escalado: state.escalado,
          fallback: state.fallbackMotivo !== null,
        });
        await input.efeitos.atualizarResumoSePreciso();
        return { respostaFinal: texto };
      };

      const grafo = new StateGraph(StateAnnotation)
        .addNode('montar_contexto', montarContexto)
        .addNode('agente', agente)
        .addNode('tools', tools)
        .addNode('guardrails_saida', guardrailsSaida)
        .addNode('fallback', fallback)
        .addNode('responder', responder)
        .addEdge(START, 'montar_contexto')
        .addEdge('montar_contexto', 'agente')
        .addConditionalEdges('agente', (state: State) => {
          if (state.fallbackMotivo) return 'fallback';
          if (state.pendingToolCalls.length > 0) return 'tools';
          return 'guardrails_saida';
        })
        .addConditionalEdges('tools', (state: State) =>
          state.fallbackMotivo ? 'fallback' : 'agente',
        )
        .addConditionalEdges('guardrails_saida', (state: State) =>
          state.fallbackMotivo ? 'fallback' : 'responder',
        )
        .addEdge('fallback', 'responder')
        .addEdge('responder', END)
        .compile();

      const final = (await grafo.invoke({}, { recursionLimit: 60 })) as State;

      return {
        resposta: final.respostaFinal ?? TEXTO_FALLBACK,
        escalado: final.escalado,
        fallback: final.fallbackMotivo !== null,
        fallbackMotivo: final.fallbackMotivo,
        eventos: final.eventos,
        tokensEntrada: final.tokensEntrada,
        tokensSaida: final.tokensSaida,
        latenciaMs: Date.now() - inicio,
      };
    },
  };
}
