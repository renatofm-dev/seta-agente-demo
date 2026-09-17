import { z } from 'zod';

/**
 * Ciclo comercial no TS Explorer — 045: pessoa, "casal" (o lead, no vocabulário
 * do fornecedor) e venda.
 *
 * Três características do fornecedor mandam no desenho, todas provadas nas
 * fixtures da coleção:
 *
 *  1. **`setcasal` devolve string VAZIA.** Sem id e sem campo de referência
 *     externa — a mesma armadilha de `CriarSolicitacaoReserva` na 038. Quem
 *     grava não sabe o que criou: o id sai de um READ-BACK por chave natural
 *     (`GetCasaisPorPeriodo` + CPF), e a idempotência fica em `erp_escrita`.
 *  2. **`SetVenda` devolve PROSA**: `"IdContrato: 285"`. A extração é por regex
 *     estrita; 200 com prosa inesperada é erro de negócio, não sucesso.
 *  3. **`SetPessoa` devolve o id NU** (`358`), sem envelope e sem prosa. Três
 *     rotas de escrita, três formatos de resposta diferentes — é o fornecedor,
 *     e o adapter absorve isso para que o resto do produto não precise saber.
 */

// --- entradas ---------------------------------------------------------------

export const PessoaInputSchema = z.object({
  nome: z.string().min(1).max(120),
  /**
   * CPF do comprador. Como todo CPF desta base de código, vem do parser
   * determinístico sobre o texto cru — nunca da saída estruturada do modelo
   * (mesma regra da 038; o token de anonimização gravado num ERP de terceiro
   * é dado errado que ninguém corrige depois).
   */
  cpf: z.string().min(11).max(14),
});
export type PessoaInput = z.input<typeof PessoaInputSchema>;

export const LeadInputSchema = z.object({
  nome: z.string().min(1).max(120),
  cpf: z.string().max(14).nullish(),
  email: z.string().max(120).nullish(),
  telefone: z.string().max(30).nullish(),
  /** Código de "originado pelo agente" no cliente — pergunta aberta ao fornecedor. */
  idOrigemCasal: z.number().int().positive().nullish(),
});
export type LeadInput = z.input<typeof LeadInputSchema>;

/** Uma parcela do contrato que a venda abre (entrada/sinal e saldo). */
export const ParcelaVendaSchema = z.object({
  idMeioPagamento: z.number().int().positive(),
  /** 1 = ENTRADA, 2 = SALDO no espelho. */
  idTipoOrigem: z.number().int().positive(),
  vencimento: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  valorCentavos: z.number().int().nonnegative(),
});
export type ParcelaVenda = z.input<typeof ParcelaVendaSchema>;

export const VendaInputSchema = z.object({
  idCasal: z.number().int().positive().nullish(),
  idComprador: z.number().int().positive(),
  idProduto: z.number().int().positive(),
  idCotaUh: z.number().int().positive(),
  valorCentavos: z.number().int().nonnegative(),
  parcelas: z.array(ParcelaVendaSchema).min(1),
});
export type VendaInput = z.input<typeof VendaInputSchema>;

// --- respostas --------------------------------------------------------------

/** O que `GetCasaisPorPeriodo` devolve, do que o read-back precisa. */
export const CasalTseSchema = z
  .object({
    IdItem: z.number().int(),
    Nome1: z.string().nullish(),
    Cpf1: z.string().nullish(),
    DataCadastro: z.string().nullish(),
  })
  .passthrough();

export interface CasalErp {
  readonly casalId: number;
  readonly nome: string;
  readonly cpf: string;
}

export function paraCasal(bruto: unknown): CasalErp {
  const c = CasalTseSchema.parse(bruto);
  return {
    casalId: c.IdItem,
    nome: c.Nome1 ?? '',
    cpf: (c.Cpf1 ?? '').replace(/\D/g, ''),
  };
}

/**
 * Chave natural do casal: o CPF. É o único campo que o lead traz e que o TSE
 * devolve na listagem — e é por ele que o read-back reconhece o que acabou de
 * gravar. Sem CPF não há read-back possível, e o worker trata isso como falha
 * definitiva em vez de gravar um segundo casal por via das dúvidas.
 */
export function mesmoCasal(c: CasalErp, cpfAlvo: string): boolean {
  const alvo = cpfAlvo.replace(/\D/g, '');
  return alvo.length > 0 && c.cpf === alvo;
}

/**
 * `"IdContrato: 285"` → `285`.
 *
 * Estrita de propósito: qualquer outra prosa (inclusive um 200 com mensagem de
 * erro, que este fornecedor faz) precisa virar erro. Foi assim que a 036 tratou
 * `"...sob id: 42"` em `cliente.ts`, e é a mesma disciplina.
 */
export const ID_CONTRATO_DA_PROSA = /IdContrato:\s*(\d+)/i;

export function contratoDaProsa(corpo: unknown): number | null {
  const texto = typeof corpo === 'string' ? corpo : JSON.stringify(corpo ?? '');
  const achado = ID_CONTRATO_DA_PROSA.exec(texto);
  if (!achado?.[1]) return null;
  const id = Number(achado[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** `SetPessoa` devolve o id nu — `358` ou `"358"`, dependendo do serializador. */
export function pessoaDaResposta(corpo: unknown): number | null {
  const bruto = typeof corpo === 'string' ? corpo.replace(/"/g, '').trim() : corpo;
  const id = Number(bruto);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** Centavos → reais, que é a unidade do TSE em todo corpo de escrita. */
export function paraReais(centavos: number): number {
  return Math.round(centavos) / 100;
}
