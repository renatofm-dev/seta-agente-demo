import type { AIProvider } from '@seta/ai-provider';
import { z } from 'zod';

/**
 * Classificador de intenção do inbound (006): chamada CURTA ao LLM com saída
 * estruturada. Intenções != outro escalam ANTES de o agente responder.
 */

export const INTENCOES = [
  'negociar_preco',
  'tema_sensivel',
  'pedir_humano',
  'pagar',
  'reservar',
  'comprar_cota',
  'outro',
] as const;
export type Intencao = (typeof INTENCOES)[number];
const IntencaoSchema = z.enum(INTENCOES);

/**
 * Intenções que NÃO escalam: `outro` segue para o agente; `pagar` inicia o
 * fluxo de cobrança (014); `reservar` inicia o fluxo de reserva (038).
 */
export type IntencaoQueEscala = Exclude<Intencao, 'outro' | 'pagar' | 'reservar'>;

export const TRIGGER_POR_INTENCAO: Readonly<Record<IntencaoQueEscala, string>> = {
  negociar_preco: 'negociacao_preco',
  tema_sensivel: 'tema_sensivel',
  pedir_humano: 'pedido_explicito',
  /** 014: venda de cota nova fica com o comercial — escalada com texto próprio. */
  comprar_cota: 'interesse_compra',
};

export function intencaoEscala(i: Intencao): i is IntencaoQueEscala {
  return i !== 'outro' && i !== 'pagar' && i !== 'reservar';
}

export interface ClassificacaoIntencao {
  readonly intencao: Intencao;
  /** Usage do provider — a 010 exige contabilizar TODA chamada (#30). */
  readonly tokensEntrada: number;
  readonly tokensSaida: number;
}

const TIMEOUT_CLASSIFICADOR_MS = 10_000;

export async function classificarIntencao(
  provider: AIProvider,
  textoUsuario: string,
  temasSensiveis: readonly string[],
  opts?: { readonly traceId?: string },
): Promise<ClassificacaoIntencao> {
  const res = await provider.chat({
    // chamada curta merece timeout curto — pendurada não segura o turno (#27)
    signal: AbortSignal.timeout(TIMEOUT_CLASSIFICADOR_MS),
    traceId: opts?.traceId, // 016
    messages: [
      {
        role: 'system',
        content:
          'Classifique a mensagem do cliente em EXATAMENTE uma categoria. Responda só a palavra.\n' +
          '- negociar_preco: pede desconto, abatimento, condição especial ou negociação de valores\n' +
          `- tema_sensivel: menciona algum destes temas: ${temasSensiveis.join(', ') || '(nenhum configurado)'}\n` +
          '- pedir_humano: pede explicitamente para falar com uma pessoa/atendente\n' +
          '- pagar: quer pagar, quitar ou regularizar parcelas do contrato; pede boleto, PIX ou link de pagamento PARA PAGAR; diz que quer fazer/fechar o pagamento ou a compra\n' +
          '- reservar: quer USAR o contrato que já tem — reservar ou marcar hospedagem, ' +
          'semana, período, diária ou feriado; perguntar hotéis/unidades disponíveis para usar os pontos\n' +
          '- comprar_cota: quer ADQUIRIR outra cota, fazer upgrade ou comprar um produto novo ' +
          '(dinheiro saindo para adquirir, não uso do que já é dele)\n' +
          '- outro: qualquer outra coisa (dúvidas, pedidos de informação, saudações, perguntar o que está vencido sem pedir para pagar)',
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
  return {
    intencao: parsed.success ? parsed.data : 'outro',
    tokensEntrada: res.tokensEntrada,
    tokensSaida: res.tokensSaida,
  };
}
