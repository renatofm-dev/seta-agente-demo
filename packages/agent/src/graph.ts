import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import type { ChatMessage, ToolCall, ToolDef } from '@seta/ai-provider';
import {
  type GuardrailCtx,
  runBeforeReply,
  runToolHooks,
  type ToolResultTurno,
} from '@seta/guardrails';
import type { ToolSpec } from '@seta/query-catalog';
import { z } from 'zod';
import { renderPromptBase } from './prompt.js';
import { NOME_ESCALAR, NOME_INICIAR_PAGAMENTO } from './tools-internas.js';
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
 * Guardrails (006): hooks nos três pontos; escalate responde com a mensagem
 * de transição e o ticket vai para humano (007).
 */

export const TEXTO_FALLBACK =
  'Não consegui obter essa informação com segurança agora. Prefiro não arriscar uma ' +
  'resposta errada — quer que eu acione um de nossos atendentes para te ajudar?';

export const TEXTO_TRANSICAO =
  'Entendi! Esse assunto quem resolve é um de nossos atendentes. Já estou passando sua ' +
  'conversa para a equipe — você recebe o retorno aqui mesmo. 🙂';

/** 2 falhas definitivas de tool no turno ⇒ escalar (006). */
const MAX_FALHAS_TOOL = 2;

const StateAnnotation = Annotation.Root({
  mensagens: Annotation<ChatMessage[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
  pendingToolCalls: Annotation<ToolCall[]>({ reducer: (_a, b) => b, default: () => [] }),
  toolCallsFeitas: Annotation<number>({ reducer: (_a, b) => b, default: () => 0 }),
  falhasTool: Annotation<number>({ reducer: (a, b) => a + b, default: () => 0 }),
  toolResults: Annotation<ToolResultTurno[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
  draft: Annotation<string | null>({ reducer: (_a, b) => b, default: () => null }),
  fallbackMotivo: Annotation<string | null>({ reducer: (_a, b) => b, default: () => null }),
  escalado: Annotation<boolean>({ reducer: (a, b) => a || b, default: () => false }),
  escaladoTrigger: Annotation<string | null>({ reducer: (a, b) => b ?? a, default: () => null }),
  eventos: Annotation<TraceEvento[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
  tokensEntrada: Annotation<number>({ reducer: (a, b) => a + b, default: () => 0 }),
  tokensSaida: Annotation<number>({ reducer: (a, b) => a + b, default: () => 0 }),
  respostaFinal: Annotation<string | null>({ reducer: (_a, b) => b, default: () => null }),
  /** 014: tool `iniciar_pagamento` chamada neste turno. */
  fluxoPagamentoSolicitado: Annotation<boolean>({
    reducer: (a, b) => a || b,
    default: () => false,
  }),
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
      // #27: deadline também CANCELA chamadas LLM em voo — uma request
      // pendurada no provider não segura o turno além do timeout
      const abortoTurno = new AbortController();
      const timerAborto = setTimeout(() => abortoTurno.abort(), input.limites.timeoutMs);
      const toolsPorNome = new Map(input.tools.map((t) => [t.name, t]));
      const toolDefs = paraToolDefs(input.tools);
      const guardrailCtx = (state: State): GuardrailCtx => ({
        traceId: input.session.traceId,
        textoUsuario: input.textoUsuario,
        toolResults: state.toolResults,
      });

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
        let res: Awaited<ReturnType<typeof deps.provider.chat>>;
        try {
          res = await deps.provider.chat({
            messages: state.mensagens,
            tools: toolDefs,
            signal: abortoTurno.signal,
            traceId: input.session.traceId, // 016: anonimização atribuída ao turno
          });
        } catch (err) {
          if (abortoTurno.signal.aborted) {
            return { fallbackMotivo: 'timeout de turno' }; // LLM cancelado em voo
          }
          throw err;
        }
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
      ): Promise<{
        resultado: { rows: readonly Record<string, unknown>[]; truncated: boolean } | null;
        erro?: string;
      }> => {
        let tentativas = 0;
        for (;;) {
          try {
            const r = await spec.execute(params, input.session);
            return { resultado: { rows: r.rows, truncated: r.truncated } };
          } catch (err) {
            tentativas += 1;
            if (tentativas > input.limites.retriesPorTool) {
              return { resultado: null, erro: err instanceof Error ? err.message : String(err) };
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
        const novosResults: ToolResultTurno[] = [];
        let escalado = false;
        let escaladoTrigger: string | null = null;
        let fallbackMotivo: string | null = null;
        let falhas = 0;
        let fluxoPagamentoSolicitado = false;

        for (const call of state.pendingToolCalls) {
          const t0 = Date.now();
          const spec = toolsPorNome.get(call.name);
          let params: Record<string, unknown> = {};
          let corpo: string;
          let erro: string | undefined;

          if (!spec) {
            erro = `tool desconhecida: ${call.name}`;
            corpo = JSON.stringify({ erro });
            falhas += 1;
          } else {
            try {
              params = JSON.parse(call.argumentsJson || '{}') as Record<string, unknown>;
            } catch {
              params = {};
            }
            // guardrails beforeTool (006)
            const antes = await runToolHooks(
              guardrails,
              'beforeTool',
              { nome: call.name, params },
              guardrailCtx(state),
            );
            for (const v of antes.verdicts) {
              eventos.push({
                tipo: 'verdict',
                guardrail: v.guardrail,
                hook: v.hook,
                verdict: v.verdict,
              });
            }
            if (antes.terminal) {
              if (antes.terminal.tipo === 'escalate') {
                escalado = true;
                escaladoTrigger = antes.terminal.trigger;
              }
              erro = `tool bloqueada por guardrail`;
              corpo = JSON.stringify({ erro });
            } else {
              if (call.name === NOME_ESCALAR) {
                escalado = true;
                escaladoTrigger = escaladoTrigger ?? 'pedido_do_agente';
              }
              if (call.name === NOME_INICIAR_PAGAMENTO) fluxoPagamentoSolicitado = true;
              const r = await executarTool(spec, params);
              erro = r.erro;
              if (erro) falhas += 1;
              corpo = erro ? JSON.stringify({ erro }) : JSON.stringify(r.resultado);
              if (!erro && r.resultado) {
                const resultTurno: ToolResultTurno = {
                  nome: call.name,
                  priceSource: spec.priceSource,
                  rows: r.resultado.rows,
                };
                novosResults.push(resultTurno);
                // guardrails afterTool (006)
                const depois = await runToolHooks(
                  guardrails,
                  'afterTool',
                  resultTurno,
                  guardrailCtx(state),
                );
                for (const v of depois.verdicts) {
                  eventos.push({
                    tipo: 'verdict',
                    guardrail: v.guardrail,
                    hook: v.hook,
                    verdict: v.verdict,
                  });
                }
                if (depois.terminal?.tipo === 'escalate') {
                  escalado = true;
                  escaladoTrigger = depois.terminal.trigger;
                  fallbackMotivo = `guardrail afterTool: ${depois.terminal.trigger}`;
                } else if (depois.terminal?.tipo === 'block') {
                  fallbackMotivo = `guardrail afterTool: ${depois.terminal.reason}`;
                }
              }
            }
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
        if (escalado && !state.escalado) eventos.push({ tipo: 'escalado' });

        // 2 falhas definitivas de tool no turno ⇒ escalar (006)
        if (state.falhasTool + falhas >= MAX_FALHAS_TOOL && !fallbackMotivo) {
          fallbackMotivo = `${MAX_FALHAS_TOOL} falhas de tool no turno`;
          escalado = true;
          escaladoTrigger = escaladoTrigger ?? 'falhas_tool';
        }

        return {
          mensagens: novasMensagens,
          eventos,
          escalado,
          escaladoTrigger,
          falhasTool: falhas,
          toolResults: novosResults,
          toolCallsFeitas: state.toolCallsFeitas + state.pendingToolCalls.length,
          pendingToolCalls: [],
          fluxoPagamentoSolicitado,
          ...(fallbackMotivo ? { fallbackMotivo } : {}),
        };
      };

      const guardrailsSaida = async (state: State): Promise<Partial<State>> => {
        const r = await runBeforeReply(guardrails, state.draft ?? '', guardrailCtx(state));
        const eventos: TraceEvento[] = r.verdicts.map((v) => ({
          tipo: 'verdict',
          guardrail: v.guardrail,
          hook: v.hook,
          verdict: v.verdict,
          // #34: o draft real descartado fica no trace — sem ele o sinal de
          // correção HITL pareava o humano com o texto boilerplate de transição
          ...(v.verdict.tipo === 'block' || v.verdict.tipo === 'escalate'
            ? { draftDescartado: state.draft ?? '' }
            : {}),
        }));
        if (r.terminal) {
          const escalate = r.terminal.tipo === 'escalate';
          return {
            eventos,
            escalado: escalate,
            escaladoTrigger: escalate ? r.terminal.trigger : null,
            fallbackMotivo: escalate
              ? `guardrail: escalate(${r.terminal.trigger})`
              : `guardrail: block(${r.terminal.reason})`,
          };
        }
        return { eventos, draft: r.draft }; // rewrites aplicados
      };

      const fallback = async (state: State): Promise<Partial<State>> => {
        return {
          eventos: [{ tipo: 'fallback', motivo: state.fallbackMotivo ?? 'desconhecido' }],
          draft: state.escalado ? TEXTO_TRANSICAO : TEXTO_FALLBACK,
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

      let final: State;
      try {
        final = (await grafo.invoke({}, { recursionLimit: 60 })) as State;
      } finally {
        clearTimeout(timerAborto);
      }

      return {
        resposta: final.respostaFinal ?? TEXTO_FALLBACK,
        escalado: final.escalado,
        escaladoTrigger: final.escaladoTrigger,
        fallback: final.fallbackMotivo !== null,
        fallbackMotivo: final.fallbackMotivo,
        eventos: final.eventos,
        tokensEntrada: final.tokensEntrada,
        tokensSaida: final.tokensSaida,
        latenciaMs: Date.now() - inicio,
        fluxoPagamentoSolicitado: final.fluxoPagamentoSolicitado,
      };
    },
  };
}
