import type { AIProvider } from '@seta/ai-provider';
import { z } from 'zod';

/**
 * Classificador de intenção do inbound (006): chamada CURTA ao LLM com saída
 * estruturada. Intenções != outro escalam ANTES de o agente responder.
 */

export const INTENCOES = ['negociar_preco', 'tema_sensivel', 'pedir_humano', 'outro'] as const;
export type Intencao = (typeof INTENCOES)[number];
const IntencaoSchema = z.enum(INTENCOES);

export const TRIGGER_POR_INTENCAO: Readonly<Record<Exclude<Intencao, 'outro'>, string>> = {
  negociar_preco: 'negociacao_preco',
  tema_sensivel: 'tema_sensivel',
  pedir_humano: 'pedido_explicito',
};

export async function classificarIntencao(
  provider: AIProvider,
  textoUsuario: string,
  temasSensiveis: readonly string[],
): Promise<Intencao> {
  const res = await provider.chat({
    messages: [
      {
        role: 'system',
        content:
          'Classifique a mensagem do cliente em EXATAMENTE uma categoria. Responda só a palavra.\n' +
          '- negociar_preco: pede desconto, abatimento, condição especial ou negociação de valores\n' +
          `- tema_sensivel: menciona algum destes temas: ${temasSensiveis.join(', ') || '(nenhum configurado)'}\n` +
          '- pedir_humano: pede explicitamente para falar com uma pessoa/atendente\n' +
          '- outro: qualquer outra coisa (dúvidas, pedidos de informação, saudações)',
      },
      { role: 'user', content: textoUsuario },
    ],
    temperature: 0,
    maxOutputTokens: 8,
  });
  const bruto = (res.content ?? '')
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z_]/g, '');
  const parsed = IntencaoSchema.safeParse(bruto);
  // classificador em dúvida nunca bloqueia o fluxo: cai em 'outro'
  return parsed.success ? parsed.data : 'outro';
}
