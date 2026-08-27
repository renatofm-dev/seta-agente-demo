import { AIProviderConfigSchema, createOpenAICompatibleProvider } from '@seta/ai-provider';
import { createFakeProvider } from '@seta/ai-provider/testing';
import { describe, expect, it } from 'vitest';

describe('ai-provider (port + impl openai-compatible)', () => {
  it('config válida aplica defaults', () => {
    const cfg = AIProviderConfigSchema.parse({
      baseUrl: 'https://api.exemplo.com/v1',
      apiKey: 'sk-teste',
      model: 'modelo-demo',
    });
    expect(cfg.temperature).toBe(0.2);
    expect(cfg.maxOutputTokens).toBe(1024);
  });

  it('chat mapeia tools e tool_calls no formato OpenAI', async () => {
    const chamadas: { url: string; body: Record<string, unknown> }[] = [];
    const fetchFake = (async (url: string | URL | Request, init?: RequestInit) => {
      chamadas.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: 'call_1',
                    function: { name: 'titulos_abertos', arguments: '{}' },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 120, completion_tokens: 12 },
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const provider = createOpenAICompatibleProvider(
      { baseUrl: 'https://api.exemplo.com/v1', apiKey: 'sk', model: 'm1' },
      fetchFake,
    );
    const res = await provider.chat({
      messages: [{ role: 'user', content: 'quais boletos tenho?' }],
      tools: [{ name: 'titulos_abertos', description: 'boletos', parameters: { type: 'object' } }],
    });

    expect(chamadas[0]?.url).toBe('https://api.exemplo.com/v1/chat/completions');
    expect(chamadas[0]?.body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'titulos_abertos',
          description: 'boletos',
          parameters: { type: 'object' },
        },
      },
    ]);
    expect(res.toolCalls).toEqual([{ id: 'call_1', name: 'titulos_abertos', argumentsJson: '{}' }]);
    expect(res.tokensEntrada).toBe(120);
    expect(res.finishReason).toBe('tool_calls');
  });

  it('mensagens assistant com toolCalls e tool com toolCallId viajam no formato certo', async () => {
    let corpo: Record<string, unknown> = {};
    const fetchFake = (async (_url: string | URL | Request, init?: RequestInit) => {
      corpo = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
        { status: 200 },
      );
    }) as typeof fetch;
    const provider = createOpenAICompatibleProvider(
      { baseUrl: 'https://api.exemplo.com/v1', apiKey: 'sk', model: 'm1' },
      fetchFake,
    );
    await provider.chat({
      messages: [
        { role: 'user', content: 'oi' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call_9', name: 't', argumentsJson: '{"a":1}' }],
        },
        { role: 'tool', content: '[]', toolCallId: 'call_9' },
      ],
    });
    const msgs = corpo.messages as Record<string, unknown>[];
    expect(msgs[1]).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'call_9' }] });
    expect(msgs[2]).toMatchObject({ role: 'tool', tool_call_id: 'call_9' });
  });

  it('embed exige EMBEDDING_MODEL e ordena por index', async () => {
    const semEmbedding = createOpenAICompatibleProvider({
      baseUrl: 'https://api.exemplo.com/v1',
      apiKey: 'sk',
      model: 'm1',
    });
    await expect(semEmbedding.embed(['x'])).rejects.toThrow(/EMBEDDING_MODEL/);

    const fetchFake = (async () =>
      new Response(
        JSON.stringify({
          data: [
            { index: 1, embedding: [0.2] },
            { index: 0, embedding: [0.1] },
          ],
        }),
        { status: 200 },
      )) as typeof fetch;
    const provider = createOpenAICompatibleProvider(
      { baseUrl: 'https://api.exemplo.com/v1', apiKey: 'sk', model: 'm1', embeddingModel: 'e1' },
      fetchFake,
    );
    const vetores = await provider.embed(['a', 'b']);
    expect(vetores[0]?.[0]).toBeCloseTo(0.1);
    expect(vetores[1]?.[0]).toBeCloseTo(0.2);
  });

  it('fake provider consome fila na ordem e registra requests', async () => {
    const fake = createFakeProvider()
      .chamaTool('titulos_abertos', {})
      .respondeTexto('Você tem 2 boletos.');
    const r1 = await fake.chat({ messages: [{ role: 'user', content: 'boletos?' }] });
    expect(r1.toolCalls[0]?.name).toBe('titulos_abertos');
    const r2 = await fake.chat({ messages: [] });
    expect(r2.content).toBe('Você tem 2 boletos.');
    expect(fake.requests).toHaveLength(2);
    await expect(fake.chat({ messages: [] })).rejects.toThrow(/fila de respostas vazia/);
  });
});
