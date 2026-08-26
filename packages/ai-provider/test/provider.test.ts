import { AIProviderConfigSchema, ChatMessageSchema } from '@seta/ai-provider';
import { describe, expect, it } from 'vitest';

describe('ai-provider (port)', () => {
  it('config válida aplica defaults de temperature e maxOutputTokens', () => {
    const cfg = AIProviderConfigSchema.parse({
      baseUrl: 'https://api.exemplo.com/v1',
      apiKey: 'sk-teste',
      model: 'modelo-demo',
    });
    expect(cfg.temperature).toBe(0.2);
    expect(cfg.maxOutputTokens).toBe(1024);
  });

  it('rejeita apiKey vazia e temperature fora da faixa', () => {
    const base = { baseUrl: 'https://api.exemplo.com/v1', apiKey: 'k', model: 'm' };
    expect(AIProviderConfigSchema.safeParse({ ...base, apiKey: '' }).success).toBe(false);
    expect(AIProviderConfigSchema.safeParse({ ...base, temperature: 3 }).success).toBe(false);
  });

  it('mensagem exige role conhecida', () => {
    expect(ChatMessageSchema.safeParse({ role: 'user', content: 'oi' }).success).toBe(true);
    expect(ChatMessageSchema.safeParse({ role: 'function', content: 'x' }).success).toBe(false);
  });
});
