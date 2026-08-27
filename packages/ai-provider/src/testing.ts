import type { AIProvider, ChatRequest, ChatResponse, ToolCall } from './index.js';

/**
 * Provider fake scriptável para testes determinísticos do grafo (spec 005).
 * Enfileire respostas com `respondeTexto`/`chamaTool`; cada chat() consome uma.
 */

export interface FakeAIProvider extends AIProvider {
  /** Enfileira resposta de texto puro. */
  respondeTexto(content: string): FakeAIProvider;
  /** Enfileira resposta pedindo uma tool. */
  chamaTool(name: string, args: Record<string, unknown>): FakeAIProvider;
  /** Enfileira resposta customizada (parcial). */
  enfileira(resposta: Partial<ChatResponse>): FakeAIProvider;
  /** Todas as requests recebidas, na ordem. */
  readonly requests: ChatRequest[];
}

export function createFakeProvider(): FakeAIProvider {
  const fila: Partial<ChatResponse>[] = [];
  const requests: ChatRequest[] = [];
  let contadorTool = 0;

  const fake: FakeAIProvider = {
    modelId: 'fake-model',
    requests,

    respondeTexto(content) {
      fila.push({ content, toolCalls: [] });
      return fake;
    },

    chamaTool(name, args) {
      contadorTool += 1;
      const call: ToolCall = {
        id: `call_${contadorTool}`,
        name,
        argumentsJson: JSON.stringify(args),
      };
      fila.push({ content: null, toolCalls: [call], finishReason: 'tool_calls' });
      return fake;
    },

    enfileira(resposta) {
      fila.push(resposta);
      return fake;
    },

    async chat(req) {
      requests.push(req);
      const proxima = fila.shift();
      if (!proxima) {
        throw new Error('FakeAIProvider: fila de respostas vazia — script incompleto no teste');
      }
      return {
        content: proxima.content ?? null,
        toolCalls: proxima.toolCalls ?? [],
        tokensEntrada: proxima.tokensEntrada ?? 10,
        tokensSaida: proxima.tokensSaida ?? 5,
        finishReason:
          proxima.finishReason ?? ((proxima.toolCalls?.length ?? 0) > 0 ? 'tool_calls' : 'stop'),
      };
    },

    async embed(texts) {
      // determinístico: vetor derivado do comprimento e dos char codes
      return texts.map((t) => {
        const v = new Float32Array(8);
        for (let i = 0; i < t.length; i++) {
          const idx = i % 8;
          v[idx] = ((v[idx] ?? 0) + t.charCodeAt(i) / 255) % 1;
        }
        return v;
      });
    },
  };
  return fake;
}
