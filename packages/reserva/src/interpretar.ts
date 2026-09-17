import type { AIProvider } from '@seta/ai-provider';
import { z } from 'zod';
import type { Acao, EstadoFluxo } from './tipos.js';

/**
 * Fallback por LLM, chamado SÓ quando o parser determinístico devolveu `null`.
 *
 * **O schema não tem onde caber um CPF nem uma data livre.** Não é convenção, é
 * a defesa: o modelo escolhe entre opções que já existem, e documento e período
 * continuam saindo exclusivamente do parser sobre o texto cru. Se um token de
 * anonimização escapar para o modelo, não há campo em que ele possa ser escrito.
 */

const AcaoLlmSchema = z.discriminatedUnion('acao', [
  z.object({ acao: z.literal('escolher'), indice: z.number().int().min(1).max(20) }),
  z.object({
    acao: z.literal('pagantes'),
    adultos: z.number().int().min(0).max(20),
    criancas: z.number().int().min(0).max(20),
  }),
  z.object({ acao: z.literal('pronto') }),
  z.object({ acao: z.literal('confirmar') }),
  z.object({ acao: z.literal('cancelar') }),
  z.object({ acao: z.literal('nao_entendi') }),
]);

const TIMEOUT_MS = 10_000;

function opcoesTexto(estado: EstadoFluxo): string {
  const lista = (o: readonly { descricao: string }[]) =>
    o.map((x, i) => `${i + 1}. ${x.descricao}`).join('\n');
  switch (estado.etapa) {
    case 'hotel':
      return `Opções de hotel mostradas:\n${lista(estado.hoteis)}`;
    case 'unidade':
      return `Opções de unidade mostradas:\n${lista(estado.tiposUh)}`;
    case 'pagantes':
      return 'O cliente deve informar quantos adultos e quantas crianças vão.';
    case 'hospedes':
      return 'O cliente está informando hóspedes. Só diga `pronto` se ele indicar que terminou.';
    case 'confirmacao':
      return 'O cliente deve confirmar ou cancelar a reserva apresentada.';
    default:
      return '';
  }
}

/** Revalida contra a etapa: ação fora de lugar vira `nao_entendi`, nunca erro. */
export function acaoValida(saida: z.infer<typeof AcaoLlmSchema>, estado: EstadoFluxo): Acao {
  switch (saida.acao) {
    case 'escolher': {
      const lista = estado.etapa === 'hotel' ? estado.hoteis : estado.tiposUh;
      if (estado.etapa !== 'hotel' && estado.etapa !== 'unidade') return { tipo: 'nao_entendi' };
      return saida.indice <= lista.length
        ? { tipo: 'escolher', indice: saida.indice }
        : { tipo: 'nao_entendi' };
    }
    case 'pagantes':
      return estado.etapa === 'pagantes' && saida.adultos + saida.criancas > 0
        ? { tipo: 'pagantes', adultos: saida.adultos, criancas: saida.criancas }
        : { tipo: 'nao_entendi' };
    case 'pronto':
      return estado.etapa === 'hospedes' ? { tipo: 'pronto' } : { tipo: 'nao_entendi' };
    case 'confirmar':
      return estado.etapa === 'confirmacao' ? { tipo: 'confirmar' } : { tipo: 'nao_entendi' };
    case 'cancelar':
      return { tipo: 'cancelar' };
    default:
      return { tipo: 'nao_entendi' };
  }
}

function extrairJson(texto: string): unknown {
  const limpo = texto
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  return JSON.parse(limpo);
}

export async function interpretarResposta(
  provider: AIProvider,
  estado: EstadoFluxo,
  texto: string,
  opts: { traceId?: string } = {},
): Promise<{ acao: Acao; tokensEntrada: number; tokensSaida: number }> {
  try {
    const res = await provider.chat({
      messages: [
        {
          role: 'system',
          content:
            'Você classifica a resposta de um cliente num fluxo de reserva de hotel. ' +
            `${opcoesTexto(estado)}\n` +
            'Responda SÓ com JSON, sem texto em volta, num destes formatos: ' +
            '{"acao":"escolher","indice":N} | {"acao":"pagantes","adultos":N,"criancas":N} | ' +
            '{"acao":"pronto"} | {"acao":"confirmar"} | {"acao":"cancelar"} | {"acao":"nao_entendi"}. ' +
            'Na dúvida, use nao_entendi. NUNCA invente documento, nome ou data.',
        },
        { role: 'user', content: texto },
      ],
      temperature: 0,
      maxOutputTokens: 40,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      ...(opts.traceId ? { traceId: opts.traceId } : {}),
    });
    const saida = AcaoLlmSchema.parse(extrairJson(res.content ?? ''));
    return {
      acao: acaoValida(saida, estado),
      tokensEntrada: res.tokensEntrada ?? 0,
      tokensSaida: res.tokensSaida ?? 0,
    };
  } catch {
    // modelo fora, lento ou falando bobagem: o fluxo NÃO trava por causa dele
    return { acao: { tipo: 'nao_entendi' }, tokensEntrada: 0, tokensSaida: 0 };
  }
}
