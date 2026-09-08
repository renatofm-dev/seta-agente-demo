import { z } from 'zod';

/**
 * Port AIProvider: endpoint OpenAI-compatible remoto (corte da 000).
 * Trocar para vLLM on-prem = trocar LLM_BASE_URL/LLM_MODEL — argumento de venda.
 */

export const AIProviderConfigSchema = z.object({
  baseUrl: z.url(),
  apiKey: z.string().min(1),
  model: z.string().min(1),
  embeddingModel: z.string().min(1).optional(),
  temperature: z.number().min(0).max(2).default(0.2),
  maxOutputTokens: z.number().int().min(1).default(1024),
  /** Timeout de rede por chamada (chat/embed) — request pendurada nunca segura
   * um turno além disso (#27). */
  timeoutMs: z.number().int().min(1_000).default(60_000),
});
export type AIProviderConfig = z.infer<typeof AIProviderConfigSchema>;
export type AIProviderConfigInput = z.input<typeof AIProviderConfigSchema>;

export const ChatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string(),
  /** Presente em role=assistant quando o modelo pediu tools. */
  toolCalls: z
    .array(z.object({ id: z.string(), name: z.string(), argumentsJson: z.string() }))
    .optional(),
  /** Presente em role=tool: a qual call este resultado responde. */
  toolCallId: z.string().optional(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export interface ToolDef {
  readonly name: string;
  readonly description: string;
  /** JSON Schema dos parâmetros (formato OpenAI function calling). */
  readonly parameters: Record<string, unknown>;
}

export interface ChatRequest {
  readonly messages: readonly ChatMessage[];
  readonly tools?: readonly ToolDef[];
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  /** Cancela a chamada em voo (deadline do turno — #27). */
  readonly signal?: AbortSignal;
  /** 016: atribuição no trace/observabilidade (o decorator de anonimização usa). */
  readonly traceId?: string;
  /** 016: hints para o decorator de anonimização; ignorado por providers reais. */
  readonly anonimizacao?: {
    /** false ⇒ resposta volta tokenizada (`[NOME_1]`) — o distiller quer skills genéricas. */
    readonly destokenizar?: boolean;
  };
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly argumentsJson: string;
}

export interface ChatResponse {
  readonly content: string | null;
  readonly toolCalls: readonly ToolCall[];
  readonly tokensEntrada: number;
  readonly tokensSaida: number;
  readonly finishReason: string;
}

export interface AIProvider {
  readonly modelId: string;
  chat(req: ChatRequest): Promise<ChatResponse>;
  embed(texts: readonly string[]): Promise<Float32Array[]>;
}

export { createOpenAICompatibleProvider } from './openai-compatible.js';
