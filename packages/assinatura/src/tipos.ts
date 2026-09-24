import { z } from 'zod';

/**
 * 046 — o port de assinatura eletrônica.
 *
 * A API do TS Explorer **não assina**: as 90 rotas da coleção cobrem cadastro,
 * venda, financeiro, utilização e operador, e as 8 ocorrências de "Assinatura"
 * lá dentro são `TvAssinatura`, campo do formulário de qualificação de lead.
 * Quem conecta o Autentique é o sistema do fornecedor, fora da API — então a
 * assinatura entra pelo nosso lado, atrás de um port, como o PSP da 014.
 *
 * O port tem só dois verbos porque o fluxo tem só dois momentos: criar o
 * documento (e receber de volta o link que o comprador toca) e **ler o evento**
 * que diz que assinaram. Consultar estado por conta própria não entrou: o
 * estado que vale é o nosso, gravado quando o evento chega, e inventar um
 * `obter()` que o simulado não sabe responder seria interface de enfeite.
 */

/** Quem assina. O e-mail é do Autentique; o CPF, o que o contrato mostra. */
export const SignatarioSchema = z.object({
  nome: z.string().min(1),
  email: z.email().optional(),
  cpf: z
    .string()
    .transform((s) => s.replaceAll(/\D/g, ''))
    .pipe(z.string().regex(/^\d{11}$/))
    .optional(),
});
export type Signatario = z.infer<typeof SignatarioSchema>;

export interface DocumentoParaAssinar {
  /** Nome que o signatário vê na lista do provedor: "Contrato 10123". */
  readonly nome: string;
  /**
   * Os BYTES do PDF. Nunca caminho de arquivo e nunca URL: o contrato é dado
   * pessoal (nome, CPF, valor) e não é escrito em disco em lugar nenhum desta
   * plataforma — mesma regra do boleto da 040.
   */
  readonly pdf: Uint8Array;
  readonly signatarios: readonly Signatario[];
}

export interface LinkDeAssinatura {
  /** Nome do signatário a quem este link pertence. */
  readonly signatario: string;
  readonly url: string;
}

export interface AssinaturaCriada {
  /** Id do documento NO PROVEDOR — é por ele que o evento volta. */
  readonly id: string;
  readonly links: readonly LinkDeAssinatura[];
}

export const ESTADOS_ASSINATURA = ['pendente', 'assinada', 'recusada'] as const;
export type EstadoAssinatura = (typeof ESTADOS_ASSINATURA)[number];

export interface EventoAssinatura {
  /** O `id` devolvido por `criarDocumento`. */
  readonly idDocumento: string;
  readonly estado: EstadoAssinatura;
  /** Quando assinaram, ISO. Ausente enquanto não assinaram. */
  readonly assinadoEm: string | null;
  /** Onde buscar a via assinada, quando o provedor publica uma. */
  readonly urlAssinado: string | null;
}

export interface AssinaturaProvider {
  /** Nome curto do provedor, para log e para a linha do console. */
  readonly nome: string;
  criarDocumento(d: DocumentoParaAssinar): Promise<AssinaturaCriada>;
  /**
   * Traduz o corpo do webhook do provedor. Devolve `null` quando o corpo não é
   * um evento reconhecível — quem chama responde 200 assim mesmo, porque
   * provedor que recebe erro re-tenta para sempre.
   */
  lerEvento(corpo: unknown): EventoAssinatura | null;
}
