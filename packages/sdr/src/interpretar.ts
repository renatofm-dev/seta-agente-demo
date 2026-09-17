import type { AIProvider } from '@seta/ai-provider';
import { z } from 'zod';
import { descricaoCota, formatarReais } from './render.js';
import { type Acao, type EstadoFluxo, PERIODOS_VALIDOS } from './tipos.js';

/**
 * Fallback com LLM para quando o parser determinístico não reconhece a resposta
 * ("somos eu, minha esposa e as crianças", "acho caro"). Saída JSON estrita,
 * validada com Zod; qualquer dúvida vira `nao_entendi` — o modelo interpreta a
 * ESCOLHA, nunca decide valor. O valor pedido pelo lead é o único número que
 * passa, e ele só serve para comparar com o piso.
 */

const TIMEOUT_MS = 10_000;

const AcaoLlmSchema = z.discriminatedUnion('acao', [
  z.object({ acao: z.literal('pessoas'), n: z.number().int().min(1).max(12) }),
  z.object({ acao: z.literal('periodos'), n: z.number().int().min(1).max(3) }),
  z.object({ acao: z.literal('escolher'), indice: z.number().int().min(1).max(3) }),
  z.object({ acao: z.literal('pedir_melhor') }),
  z.object({ acao: z.literal('pedir_valor'), reais: z.number().positive() }),
  z.object({ acao: z.literal('aceitar') }),
  z.object({ acao: z.literal('agendar'), texto: z.string().min(1).max(200) }),
  z.object({ acao: z.literal('cancelar') }),
  z.object({ acao: z.literal('nao_entendi') }),
]);

export interface Interpretacao {
  readonly acao: Acao;
  readonly tokensEntrada: number;
  readonly tokensSaida: number;
}

function formatosDaEtapa(estado: EstadoFluxo): string {
  switch (estado.etapa) {
    case 'qualificacao':
      return estado.perfil.pessoas === null
        ? '{"acao":"pessoas","n":N} (quantas pessoas viajam, 1..12)'
        : `{"acao":"periodos","n":N} (vezes por ano: ${PERIODOS_VALIDOS.join(', ')})`;
    case 'apresentacao':
      return `{"acao":"escolher","indice":N} (1..${estado.opcoes.length})`;
    case 'oferta':
      return (
        '{"acao":"aceitar"} | {"acao":"pedir_melhor"} (quer valor melhor, sem dizer quanto) | ' +
        '{"acao":"pedir_valor","reais":N} (disse quanto pagaria, em reais)'
      );
    case 'agendamento':
      return '{"acao":"agendar","texto":"nome e horário como o cliente escreveu"}';
    default:
      return '';
  }
}

function opcoesTexto(estado: EstadoFluxo): string {
  if (estado.etapa !== 'apresentacao') return '';
  return estado.opcoes
    .map((c, i) => `${i + 1}) ${descricaoCota(c)} ${formatarReais(c.valorTabelaCentavos)}`)
    .join('\n');
}

export function extrairJson(conteudo: string): unknown {
  const m = /\{[\s\S]*\}/.exec(conteudo);
  if (!m) throw new Error('sem JSON');
  return JSON.parse(m[0]);
}

/** Converte a saída do modelo em Acao válida PARA A ETAPA; fora disso, nao_entendi. */
export function acaoValida(saida: z.infer<typeof AcaoLlmSchema>, estado: EstadoFluxo): Acao {
  const e = estado.etapa;
  switch (saida.acao) {
    case 'pessoas':
      return e === 'qualificacao' ? { tipo: 'pessoas', n: saida.n } : { tipo: 'nao_entendi' };
    case 'periodos':
      return e === 'qualificacao' ? { tipo: 'periodos', n: saida.n } : { tipo: 'nao_entendi' };
    case 'escolher':
      return e === 'apresentacao' && estado.opcoes[saida.indice - 1]
        ? { tipo: 'escolher', indice: saida.indice }
        : { tipo: 'nao_entendi' };
    case 'pedir_melhor':
      return e === 'oferta' ? { tipo: 'pedir_melhor' } : { tipo: 'nao_entendi' };
    case 'pedir_valor':
      return e === 'oferta'
        ? { tipo: 'pedir_valor', centavos: Math.round(saida.reais * 100) }
        : { tipo: 'nao_entendi' };
    case 'aceitar':
      return e === 'oferta' ? { tipo: 'aceitar' } : { tipo: 'nao_entendi' };
    case 'agendar':
      return e === 'agendamento'
        ? { tipo: 'agendar', texto: saida.texto }
        : { tipo: 'nao_entendi' };
    case 'cancelar':
      return { tipo: 'cancelar' };
    default:
      return { tipo: 'nao_entendi' };
  }
}

/**
 * 045: etapas em que o LLM NÃO é consultado, nunca.
 *
 * `dados` é onde o comprador manda nome e CPF. Mandar esse texto ao modelo
 * seria mandar dado pessoal para fora sem necessidade — e aceitar a resposta
 * dele seria deixar um CPF nascer de uma saída estruturada, que é exatamente o
 * que a 038 proibiu. O parser determinístico resolve ou re-pergunta.
 *
 * `fechamento` está aqui por outro motivo: nada que o lead escreva avança o
 * fluxo (quem avança é o webhook do PSP), então não há nada a interpretar.
 */
const SEM_LLM: readonly EstadoFluxo['etapa'][] = ['dados', 'fechamento'];

export async function interpretarResposta(
  provider: AIProvider,
  estado: EstadoFluxo,
  texto: string,
  opts?: { readonly traceId?: string },
): Promise<Interpretacao> {
  if (SEM_LLM.includes(estado.etapa)) {
    return { acao: { tipo: 'nao_entendi' }, tokensEntrada: 0, tokensSaida: 0 };
  }
  try {
    const res = await provider.chat({
      signal: AbortSignal.timeout(TIMEOUT_MS),
      traceId: opts?.traceId,
      temperature: 0,
      maxOutputTokens: 60,
      messages: [
        {
          role: 'system',
          content:
            'Você interpreta a resposta de um interessado em comprar uma cota de resort, num ' +
            `fluxo pelo WhatsApp.\nEtapa atual: ${estado.etapa}.\n` +
            (opcoesTexto(estado) ? `Opções apresentadas:\n${opcoesTexto(estado)}\n` : '') +
            'Responda SOMENTE um JSON, sem texto ao redor, em um destes formatos:\n' +
            `${formatosDaEtapa(estado)} | {"acao":"cancelar"} | {"acao":"nao_entendi"}\n` +
            'Em dúvida, responda {"acao":"nao_entendi"}. Nunca invente valor nem opção.',
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
