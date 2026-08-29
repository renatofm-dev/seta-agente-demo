import {
  type AIProvider,
  type AIProviderConfigInput,
  AIProviderConfigSchema,
  type ChatMessage,
  type ChatResponse,
} from './index.js';

/**
 * Implementação única do port: cliente OpenAI-compatible via fetch (sem SDK).
 * Funciona com OpenAI/OpenRouter hoje e vLLM on-prem amanhã.
 */

interface OpenAIToolCall {
  id: string;
  function: { name: string; arguments: string };
}

interface OpenAIChatResponse {
  choices: {
    message: { content: string | null; tool_calls?: OpenAIToolCall[] };
    finish_reason: string;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function paraOpenAIMessage(m: ChatMessage): Record<string, unknown> {
  if (m.role === 'assistant' && m.toolCalls?.length) {
    return {
      role: 'assistant',
      content: m.content || null,
      tool_calls: m.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.argumentsJson },
      })),
    };
  }
  if (m.role === 'tool') {
    return { role: 'tool', content: m.content, tool_call_id: m.toolCallId };
  }
  return { role: m.role, content: m.content };
}

export function createOpenAICompatibleProvider(
  configInput: AIProviderConfigInput,
  fetchFn: typeof fetch = fetch,
): AIProvider {
  const config = AIProviderConfigSchema.parse(configInput);
  const base = config.baseUrl.replace(/\/+$/, '');

  async function post(
    path: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    // timeout próprio SEMPRE presente; sinal externo (deadline do turno) compõe
    const sinais = [AbortSignal.timeout(config.timeoutMs)];
    if (signal) sinais.push(signal);
    const res = await fetchFn(`${base}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.any(sinais),
    });
    if (!res.ok) {
      throw new Error(`AIProvider ${path} ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    return res.json();
  }

  return {
    modelId: config.model,

    async chat(req): Promise<ChatResponse> {
      const corpo: Record<string, unknown> = {
        model: config.model,
        messages: req.messages.map(paraOpenAIMessage),
        temperature: req.temperature ?? config.temperature,
        max_tokens: req.maxOutputTokens ?? config.maxOutputTokens,
      };
      if (req.tools?.length) {
        corpo.tools = req.tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }));
      }
      const data = (await post('/chat/completions', corpo, req.signal)) as OpenAIChatResponse;
      const escolha = data.choices[0];
      if (!escolha) throw new Error('AIProvider: resposta sem choices');
      return {
        content: escolha.message.content,
        toolCalls: (escolha.message.tool_calls ?? []).map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          argumentsJson: tc.function.arguments,
        })),
        tokensEntrada: data.usage?.prompt_tokens ?? 0,
        tokensSaida: data.usage?.completion_tokens ?? 0,
        finishReason: escolha.finish_reason,
      };
    },

    async embed(texts): Promise<Float32Array[]> {
      if (!config.embeddingModel) {
        throw new Error('EMBEDDING_MODEL não configurado — embed indisponível');
      }
      const data = (await post('/embeddings', {
        model: config.embeddingModel,
        input: texts,
      })) as { data: { index: number; embedding: number[] }[] };
      return [...data.data]
        .sort((a, b) => a.index - b.index)
        .map((d) => Float32Array.from(d.embedding));
    },
  };
}
