import type { AIProvider } from '@seta/ai-provider';
import { MetodoPagamentoSchema } from '@seta/payment-provider';
import { z } from 'zod';
import { descricaoParcela, formatarReais } from './render.js';
import { type Acao, type EstadoFluxo, opcoesDe } from './tipos.js';

/**
 * Fallback com LLM para quando o parser determinístico não reconhece a resposta
 * ("a de julho", "pode ser no pix mesmo"). Saída JSON estrita, validada com Zod;
 * qualquer dúvida vira `nao_entendi` — o modelo interpreta a ESCOLHA, nunca
 * decide valor ou parcela por conta própria.
 */

const TIMEOUT_MS = 10_000;

const AcaoLlmSchema = z.discriminatedUnion('acao', [
  z.object({ acao: z.literal('escolher'), indice: z.number().int().min(1) }),
  z.object({ acao: z.literal('todas') }),
  z.object({ acao: z.literal('metodo'), metodo: MetodoPagamentoSchema }),
  z.object({ acao: z.literal('confirmar') }),
  z.object({ acao: z.literal('cancelar') }),
  z.object({ acao: z.literal('nao_entendi') }),
]);

export interface Interpretacao {
  readonly acao: Acao;
  readonly tokensEntrada: number;
  readonly tokensSaida: number;
}

function opcoesTexto(estado: EstadoFluxo): string {
  switch (estado.etapa) {
    case 'selecao':
      return opcoesDe(estado)
        .map((o, i) =>
          o.tipo === 'titulo'
            ? `${i + 1}) ${descricaoParcela(o.candidato)} ${formatarReais(o.candidato.valorCentavos)} vencimento ${o.candidato.vencimento}`
            : `${i + 1}) todas as vencidas`,
        )
        .join('\n');
    case 'metodo':
      return '1) boleto\n2) pix\n3) cartao (link de pagamento)';
    case 'confirmacao':
      return 'SIM confirma a geração do pagamento; NÃO cancela; também pode trocar o método (boleto|pix|cartao).';
    default:
      return '';
  }
}

export function extrairJson(conteudo: string): unknown {
  const m = /\{[\s\S]*\}/.exec(conteudo);
  if (!m) throw new Error('sem JSON');
  return JSON.parse(m[0]);
}

/** Converte a saída do modelo em Acao válida PARA A ETAPA; fora disso, nao_entendi. */
export function acaoValida(saida: z.infer<typeof AcaoLlmSchema>, estado: EstadoFluxo): Acao {
  switch (saida.acao) {
    case 'escolher':
      if (estado.etapa !== 'selecao' || !opcoesDe(estado)[saida.indice - 1]) {
        return { tipo: 'nao_entendi' };
      }
      return { tipo: 'escolher', indice: saida.indice };
    case 'todas':
      return estado.etapa === 'selecao' ? { tipo: 'todas' } : { tipo: 'nao_entendi' };
    case 'metodo':
      return estado.etapa === 'metodo' || estado.etapa === 'confirmacao'
        ? { tipo: 'metodo', metodo: saida.metodo }
        : { tipo: 'nao_entendi' };
    case 'confirmar':
      return estado.etapa === 'confirmacao' ? { tipo: 'confirmar' } : { tipo: 'nao_entendi' };
    case 'cancelar':
      return { tipo: 'cancelar' };
    default:
      return { tipo: 'nao_entendi' };
  }
}

export async function interpretarResposta(
  provider: AIProvider,
  estado: EstadoFluxo,
  texto: string,
): Promise<Interpretacao> {
  try {
    const res = await provider.chat({
      signal: AbortSignal.timeout(TIMEOUT_MS),
      temperature: 0,
      maxOutputTokens: 40,
      messages: [
        {
          role: 'system',
          content:
            'Você interpreta a resposta de um cliente num fluxo de pagamento por WhatsApp.\n' +
            `Etapa atual: ${estado.etapa}.\nOpções válidas:\n${opcoesTexto(estado)}\n` +
            'Responda SOMENTE um JSON, sem texto ao redor, em um destes formatos:\n' +
            '{"acao":"escolher","indice":N} | {"acao":"todas"} | {"acao":"metodo","metodo":"boleto|pix|cartao"} | ' +
            '{"acao":"confirmar"} | {"acao":"cancelar"} | {"acao":"nao_entendi"}\n' +
            'Em dúvida, responda {"acao":"nao_entendi"}. Nunca invente uma opção que não está na lista.',
        },
        { role: 'user', content: texto },
      ],
    });
    const parsed = AcaoLlmSchema.safeParse(extrairJson(res.content ?? ''));
    return {
      acao: parsed.success ? acaoValida(parsed.data, estado) : { tipo: 'nao_entendi' },
      tokensEntrada: res.tokensEntrada,
      tokensSaida: res.tokensSaida,
    };
  } catch {
    // LLM fora/lento nunca trava o fluxo: cai em nao_entendi (re-pergunta uma vez)
    return { acao: { tipo: 'nao_entendi' }, tokensEntrada: 0, tokensSaida: 0 };
  }
}
