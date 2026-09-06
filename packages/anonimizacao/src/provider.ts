import type { AIProvider, ChatMessage, ChatRequest, ChatResponse } from '@seta/ai-provider';
import type { Anonimizador } from './anonimizador.js';
import { Cofre } from './cofre.js';
import type { SinkAnonimizacao } from './tipos.js';

/**
 * Decorator do port AIProvider (016): tudo que sai passa pelo anonimizador;
 * tudo que volta é destokenizado. Um ponto de corte cobre os cinco chamadores
 * (agente, classificador, resumo, intérprete da cobrança, distiller) sem que
 * nenhum deles mude — mesmo padrão do createExecutorConciliado da 014.
 */

export interface AnonymizingProviderOpts {
  readonly anonimizador: Anonimizador;
  /** Recebe contagens por chamada — nunca valores. */
  readonly sink?: SinkAnonimizacao;
}

export function createAnonymizingProvider(
  inner: AIProvider,
  opts: AnonymizingProviderOpts,
): AIProvider {
  const { anonimizador, sink } = opts;

  return {
    get modelId() {
      return inner.modelId;
    },

    async chat(req: ChatRequest): Promise<ChatResponse> {
      const t0 = Date.now();
      const cofre = new Cofre();
      // ordem importa: numeração estável por aparição (system → histórico → atual)
      const mensagens: ChatMessage[] = [];
      let total = 0;
      for (const m of req.messages) {
        const r = await anonimizador.anonimizar([m.content], cofre);
        total += r.total;
        let toolCalls = m.toolCalls;
        if (toolCalls && toolCalls.length > 0) {
          const args = await anonimizador.anonimizar(
            toolCalls.map((c) => c.argumentsJson),
            cofre,
          );
          total += args.total;
          toolCalls = toolCalls.map((c, i) => ({
            ...c,
            argumentsJson: args.textos[i] ?? c.argumentsJson,
          }));
        }
        mensagens.push({
          ...m,
          content: r.textos[0] ?? m.content,
          ...(toolCalls ? { toolCalls } : {}),
        });
      }

      const res = await inner.chat({ ...req, messages: mensagens });

      const destokenizar = req.anonimizacao?.destokenizar ?? true;
      let desconhecidos = 0;
      let content = res.content;
      let toolCalls = res.toolCalls;
      if (destokenizar) {
        if (content !== null) {
          const d = cofre.destokenizar(content);
          content = d.texto;
          desconhecidos += d.desconhecidos;
        }
        toolCalls = res.toolCalls.map((c) => {
          const d = cofre.destokenizar(c.argumentsJson);
          desconhecidos += d.desconhecidos;
          return { ...c, argumentsJson: d.texto };
        });
      }

      sink?.({
        traceId: req.traceId,
        operacao: 'chat',
        modelo: inner.modelId,
        substituicoes: cofre.contagem(),
        total,
        tokensDesconhecidos: desconhecidos,
        latenciaMs: Date.now() - t0,
      });

      return { ...res, content, toolCalls };
    },

    async embed(texts) {
      const t0 = Date.now();
      const r = await anonimizador.anonimizar(texts);
      const out = await inner.embed(r.textos);
      sink?.({
        operacao: 'embed',
        modelo: inner.modelId,
        substituicoes: r.substituicoes,
        total: r.total,
        tokensDesconhecidos: 0,
        latenciaMs: Date.now() - t0,
      });
      return out;
    },
  };
}
