import type { MetodoPagamento } from '@seta/payment-provider';
import { type Acao, type EstadoFluxo, opcoesDe } from './tipos.js';

/**
 * Parser determinístico da resposta do cliente. Resolve o óbvio ("1", "pix",
 * "sim", "cancelar") sem gastar LLM; devolve null quando não tem certeza — aí o
 * server chama `interpretarResposta`. Em dúvida, null (nunca chuta).
 */

export function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
    .replaceAll(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}\s]/gu, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

const RE_CANCELAR =
  /^(nao|n|nao quero|agora nao|cancelar?|cancela|deixa|deixa pra la|deixa para la|depois|esquece|para|parar|nao obrigado|nao obrigada)$/;
const RE_CONFIRMAR =
  /^(sim|s|ok|okay|pode|pode sim|pode ser|confirmo|confirmar|confirmado|isso|isso mesmo|bora|manda|manda sim|gera|pode gerar|pode mandar|vai|quero|claro|yes|beleza|fechado|certo|correto)$/;
const RE_TODAS =
  /^(todas|todas as vencidas|tudo|todas elas|as duas|as tres|as 2|as 3|as quatro|as 4|as cinco|as 5)$/;
const ORDINAIS: Record<string, number> = {
  primeira: 1,
  segunda: 2,
  terceira: 3,
  quarta: 4,
  quinta: 5,
  sexta: 6,
  primeiro: 1,
  segundo: 2,
  terceiro: 3,
  quarto: 4,
  quinto: 5,
  sexto: 6,
};

export function metodoDoTexto(t: string): MetodoPagamento | null {
  if (/^(1|boleto|no boleto|por boleto|boleto bancario)$/.test(t) || /\bboleto\b/.test(t)) {
    return 'boleto';
  }
  if (/^(2|pix|no pix|por pix|via pix)$/.test(t) || /\bpix\b/.test(t)) return 'pix';
  if (
    /^(3|cartao|no cartao|por cartao|credito|link|cartao de credito|link de pagamento)$/.test(t) ||
    /\b(cartao|credito|link)\b/.test(t)
  ) {
    return 'cartao';
  }
  return null;
}

export function parsearResposta(texto: string, estado: EstadoFluxo): Acao | null {
  if (texto.includes('👍')) return estado.etapa === 'confirmacao' ? { tipo: 'confirmar' } : null;
  const t = normalizar(texto);
  if (t === '') return null;
  if (RE_CANCELAR.test(t)) return { tipo: 'cancelar' };

  switch (estado.etapa) {
    case 'selecao': {
      const opcoes = opcoesDe(estado);
      const numero = /^(\d{1,2})$/.exec(t);
      const indice = numero ? Number(numero[1]) : (ORDINAIS[t.replace(/^a /, '')] ?? null);
      if (indice !== null) {
        const opcao = opcoes[indice - 1];
        if (!opcao) return null;
        return opcao.tipo === 'todas_vencidas' ? { tipo: 'todas' } : { tipo: 'escolher', indice };
      }
      if (RE_TODAS.test(t)) return { tipo: 'todas' };
      return null;
    }
    case 'metodo': {
      const metodo = metodoDoTexto(t);
      return metodo ? { tipo: 'metodo', metodo } : null;
    }
    case 'confirmacao': {
      if (RE_CONFIRMAR.test(t)) return { tipo: 'confirmar' };
      // "melhor no pix" na confirmação = trocar o método (sem confirmar ainda)
      const metodo = metodoDoTexto(t);
      if (metodo && metodo !== estado.metodo) return { tipo: 'metodo', metodo };
      return null;
    }
    default:
      return null;
  }
}
