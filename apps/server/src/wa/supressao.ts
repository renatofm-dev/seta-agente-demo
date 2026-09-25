import { eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { supressao } from '../db/schema.js';

/**
 * 044 — a lista de supressão, e a palavra de saída.
 *
 * Disparo proativo sem opt-out é risco para o ativo mais frágil da operação: o
 * número na Meta. Quem marca "não quero receber" no WhatsApp derruba a
 * qualidade do número, e número queimado não se recupera com pedido de desculpa
 * — a gente já ficou sem número uma vez este mês.
 *
 * Duas decisões de desenho que vale conhecer antes de mexer aqui:
 *
 * 1. **O reconhecimento é determinístico, não é o classificador de intenção.**
 *    Opt-out é obrigação, não interpretação: precisa funcionar com o LLM fora
 *    do ar, e não pode depender de o modelo classificar certo. Por isso é
 *    comparação de texto normalizado, avaliada ANTES de qualquer chamada ao
 *    modelo e antes dos fluxos (pagamento, reserva, fechamento), que interceptam
 *    cedo no turno.
 *
 * 2. **"cancelar" sozinho NÃO é pedido de saída.** É a armadilha óbvia deste
 *    código: no negócio de multipropriedade, "quero cancelar" quase sempre é
 *    *distrato* — assunto que tem tool (`status_cancelamento`), skill própria e
 *    escalada para humano. Suprimir alguém que pediu para cancelar o CONTRATO
 *    seria trocar uma conversa importante por silêncio permanente. Só casam
 *    frases que falam de MENSAGEM, ou a palavra sozinha numa mensagem curta.
 */

/** Origem do registro — quem pediu a supressão, e por quê. */
export const ORIGENS_SUPRESSAO = ['pedido_do_contato', 'falha_recorrente', 'manual'] as const;
export type OrigemSupressao = (typeof ORIGENS_SUPRESSAO)[number];

/**
 * Sem acento, sem pontuação, minúsculo, espaços colapsados. A normalização é o
 * que faz "SAIR!", "Sair" e "  sair  " serem a mesma coisa.
 */
function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
    .replaceAll(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9\s]/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

/**
 * Palavra sozinha: só vale quando a mensagem é ELA e nada mais. "sair" numa
 * frase ("sair de férias", "quero sair do aplicativo") não é pedido de opt-out.
 */
const PALAVRAS_EXATAS = new Set([
  'sair',
  'parar',
  'pare',
  'stop',
  'descadastrar',
  'remover',
  'sair da lista',
  'quero sair',
  'cancelar inscricao',
  'cancelar recebimento',
]);

/**
 * Frases que falam de MENSAGEM — estas podem vir dentro de um texto maior,
 * porque não há leitura inocente para elas.
 */
const FRASES = [
  'nao quero mais receber',
  'nao quero receber mensagem',
  'nao quero receber mensagens',
  'nao me manda mais mensagem',
  'nao me mande mais mensagem',
  'nao me envie mais mensagem',
  'para de me mandar mensagem',
  'pare de me mandar mensagem',
  'remover meu numero',
  'tirar meu numero',
  'me tira da lista',
  'me tire da lista',
  'sair da lista de',
];

/** A mensagem é um pedido de não receber mais? */
export function ehPedidoDeSaida(texto: string): boolean {
  const t = normalizar(texto);
  if (t === '') return false;
  if (PALAVRAS_EXATAS.has(t)) return true;
  return FRASES.some((f) => t.includes(f));
}

export const TEXTO_SAIDA_CONFIRMADA =
  'Pronto: você não vai mais receber mensagens nossas. 👋 Se mudar de ideia, ' +
  'é só escrever aqui — sua conta e seu contrato continuam normais.';

/** Registra a supressão. Idempotente: pedir duas vezes não é erro. */
export async function suprimir(
  db: Db,
  waId: string,
  origem: OrigemSupressao,
  detalhe?: string,
): Promise<void> {
  await db
    .insert(supressao)
    .values({ waId, origem, detalhe: detalhe ?? null })
    .onConflictDoNothing({ target: supressao.waId });
}

export async function estaSuprimido(db: Db, waId: string): Promise<boolean> {
  const [linha] = await db.select().from(supressao).where(eq(supressao.waId, waId));
  return linha !== undefined;
}

/**
 * Quais destes números estão suprimidos. Uma consulta para a lista inteira: na
 * criação de um disparo de 500 destinatários, 500 idas ao banco seriam
 * desperdício — e a conferência não pode ser opcional por lentidão.
 */
export async function suprimidosEntre(db: Db, waIds: readonly string[]): Promise<Set<string>> {
  if (waIds.length === 0) return new Set();
  const linhas = await db
    .select({ waId: supressao.waId })
    .from(supressao)
    .where(inArray(supressao.waId, [...waIds]));
  return new Set(linhas.map((l) => l.waId));
}
