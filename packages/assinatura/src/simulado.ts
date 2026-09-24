import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type {
  AssinaturaCriada,
  AssinaturaProvider,
  DocumentoParaAssinar,
  EventoAssinatura,
} from './tipos.js';

/**
 * O dublê de assinatura da demo.
 *
 * Ele não guarda documento nem estado: o estado que vale é o nosso, na tabela
 * `assinatura`, e o PDF já está no ERP. O que este provider faz é o mínimo que
 * o Autentique faria — devolver um **id** e um **link por signatário** — com o
 * link apontando para a página de assinatura do nosso próprio servidor.
 *
 * Por que a página é nossa e não do simulador do ERP: o link tem de abrir no
 * celular de quem está do outro lado do WhatsApp, e em dev só a porta do server
 * atravessa o túnel — o `tse-sim` não é alcançável de fora. Em produção, o
 * mesmo domínio que serve o webhook serve a página.
 *
 * O id é o segredo do link: 32 hex aleatórios. Quem não recebeu a mensagem não
 * adivinha a URL, e é isso que impede alguém de assinar contrato alheio.
 */

export interface AssinaturaSimuladaConfig {
  /** Origem pública do server — `https://algo.trycloudflare.com`, sem barra final. */
  readonly baseUrl: string;
  /** Injetável no teste; em produção é aleatório. */
  readonly novoId?: () => string;
}

/** O que a página de assinatura manda de volta para o webhook. */
const EventoSimuladoSchema = z.object({
  documento: z.string().min(1),
  estado: z.enum(['assinada', 'recusada']),
  assinado_em: z.string().min(1).optional(),
});

export function createAssinaturaSimulada(cfg: AssinaturaSimuladaConfig): AssinaturaProvider {
  const novoId = cfg.novoId ?? (() => randomBytes(16).toString('hex'));
  const base = cfg.baseUrl.replace(/\/+$/, '');

  return {
    nome: 'simulado',

    async criarDocumento(d: DocumentoParaAssinar): Promise<AssinaturaCriada> {
      if (d.pdf.length === 0) throw new Error('assinatura: documento sem bytes');
      if (d.signatarios.length === 0) throw new Error('assinatura: documento sem signatário');
      const id = novoId();
      return {
        id,
        links: d.signatarios.map((s) => ({
          signatario: s.nome,
          url: `${base}/assinar/${id}`,
        })),
      };
    },

    lerEvento(corpo: unknown): EventoAssinatura | null {
      const evento = EventoSimuladoSchema.safeParse(corpo);
      if (!evento.success) return null;
      return {
        idDocumento: evento.data.documento,
        estado: evento.data.estado,
        assinadoEm:
          evento.data.estado === 'assinada'
            ? (evento.data.assinado_em ?? new Date().toISOString())
            : null,
        // o dublê não publica via assinada: quem serve o PDF é o ERP, e a via
        // que o comprador recebe é a mesma com o carimbo do aceite
        urlAssinado: null,
      };
    },
  };
}
