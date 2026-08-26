import { z } from 'zod';

/**
 * Port AIProvider: endpoint OpenAI-compatible remoto (corte da 000).
 * Trocar para vLLM on-prem = trocar baseUrl/model — implementação chega na spec 005.
 */

export const AIProviderConfigSchema = z.object({
  baseUrl: z.url(),
  apiKey: z.string().min(1),
  model: z.string().min(1),
  temperature: z.number().min(0).max(2).default(0.2),
  maxOutputTokens: z.number().int().min(1).default(1024),
});
export type AIProviderConfig = z.infer<typeof AIProviderConfigSchema>;

export const ChatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export interface ChatResult {
  readonly content: string;
  readonly tokensEntrada: number;
  readonly tokensSaida: number;
}

export interface AIProvider {
  chat(messages: readonly ChatMessage[]): Promise<ChatResult>;
}
