/**
 * Domínio do agente SDR para lead frio (spec 015). Puro: sem banco, sem ERP —
 * o estoque chega já lido pelo catálogo e o resultado diz ao server o que
 * fazer. O LLM nunca calcula valor: a tabela vem do ERP e o piso é aritmética
 * inteira aqui. Oferta em pontos DISCRETOS (tabela ou piso): o guardrail de
 * preço casa por conjunto exato, não por intervalo.
 */

export interface CotaDisponivel {
  /** v_cota_disponivel.cota_id */
  readonly cotaId: string;
  readonly cotaCodigo: string;
  readonly bloco: string;
  readonly andar: number;
  readonly uh: string;
  readonly capacidade: number;
  readonly tier: string;
  readonly modelo: string;
  readonly periodos: number;
  readonly valorTabelaCentavos: number;
}

export const ETAPAS = [
  'qualificacao',
  'apresentacao',
  'oferta',
  /** 045: nome e CPF do comprador — pulada na raia do cotista, que já tem os dois. */
  'dados',
  /** 045: sinal emitido, esperando o PIX cair. */
  'fechamento',
  'agendamento',
  'encerrado',
] as const;
export type Etapa = (typeof ETAPAS)[number];

export const ENCERRAMENTOS = [
  'agendado',
  /** 015b: o humano recusou e o lead não quis o piso. */
  'recusado',
  /** 045: sinal pago e venda registrada no ERP. */
  'vendido',
  'sem_interesse',
  'sem_estoque',
  'abandonado',
  'expirado',
  'aguardando_aprovacao',
  'limite_dia',
] as const;
export type Encerramento = (typeof ENCERRAMENTOS)[number];

/** O que a qualificação levanta — o suficiente para filtrar o estoque e o comercial retornar. */
export interface Perfil {
  readonly pessoas: number | null;
  readonly periodos: number | null;
  /** Nome + melhor horário, texto livre do lead (etapa agendamento). */
  readonly contato: string | null;
}

export const OFERTAS = ['tabela', 'piso'] as const;
export type Oferta = (typeof OFERTAS)[number];

export interface EstadoFluxo {
  readonly etapa: Etapa;
  readonly perfil: Perfil;
  /** Snapshot das cotas apresentadas — a escolha refere-se a ele, não a uma releitura. */
  readonly opcoes: readonly CotaDisponivel[];
  /** Índice em `opcoes` (0-based) da cota escolhida. */
  readonly escolha: number | null;
  readonly oferta: Oferta | null;
  readonly naoEntendi: number;
  readonly encerramento: Encerramento | null;
  /** 045: preenchido em `dados` (lead frio) ou já no início (cotista). */
  readonly comprador: Comprador | null;
  /**
   * 015b: valor decidido por um HUMANO — aprovação abaixo do piso ou
   * contraproposta. Quando presente vence a derivação de `oferta`, que só sabe
   * falar em tabela e piso e não teria como representar um valor negociado.
   */
  readonly valorAcordadoCentavos: number | null;
}

export type Acao =
  | { readonly tipo: 'pessoas'; readonly n: number }
  | { readonly tipo: 'periodos'; readonly n: number }
  | { readonly tipo: 'escolher'; readonly indice: number }
  /** "consegue melhorar?" — sem valor: vai para o piso. */
  | { readonly tipo: 'pedir_melhor' }
  /** "fecho por 180 mil" — com valor: compara com o piso. */
  | { readonly tipo: 'pedir_valor'; readonly centavos: number }
  | { readonly tipo: 'aceitar' }
  /** 045: nome completo e CPF, extraídos pelo PARSER do texto cru — nunca pelo LLM. */
  | { readonly tipo: 'dados'; readonly nome: string; readonly cpf: string }
  /** 045: vem do webhook do PSP, não do lead. */
  | { readonly tipo: 'sinal_pago' }
  | { readonly tipo: 'agendar'; readonly texto: string }
  /**
   * 015b: decisões que vêm do CONSOLE, não da conversa. O server as injeta
   * depois de um humano clicar; o lead nunca as produz.
   */
  | { readonly tipo: 'aprovar_humano'; readonly centavos: number }
  | { readonly tipo: 'recusar_humano' }
  | { readonly tipo: 'contrapropor_humano'; readonly centavos: number }
  | { readonly tipo: 'cancelar' }
  | { readonly tipo: 'nao_entendi' };

/** Regras que o server resolve antes de iniciar/continuar. */
export interface ContextoFluxo {
  /** Alçada do SDR em basis points (300 = 3%). */
  readonly descontoMaxBps: number;
  readonly maxPropostasDia: number;
  readonly propostasHoje: number;
  /**
   * 045: comprador já conhecido (raia do cotista — nome e CPF vêm de `contato`,
   * como a 038 faz com o hóspede titular). Presente ⇒ a etapa `dados` é pulada
   * e o CPF nunca precisa ser pedido nem trafegar pela conversa.
   */
  readonly compradorConhecido?: Comprador | null;
  /** 045: valor do sinal que o PIX vai cobrar. */
  readonly sinalCentavos?: number;
}

/** 045: quem assina a compra. O CPF vem do parser ou do cadastro, jamais do LLM. */
export interface Comprador {
  readonly nome: string;
  readonly cpf: string;
}

export type Efeito =
  | 'nenhum'
  /** Qualificação completa: o server lê o estoque e chama `apresentar`. */
  | 'buscar_estoque'
  /** Oferta feita (tabela ou piso): gravar/atualizar a proposta ANTES de enviar. */
  | 'ofertar'
  /** Pedido abaixo do piso: proposta aguardando aprovação + ticket. */
  | 'escalar_alcada'
  | 'escalar_sem_estoque'
  | 'escalar_limite'
  /** Lead aceitou e deixou contato: proposta aceita, lead agendado. */
  | 'agendar'
  /** 045: comprador identificado — emitir a cobrança do sinal e mandar o PIX. */
  | 'emitir_sinal'
  /**
   * 046: o comprador falou algo enquanto o sinal não cai. Quase sempre é "cadê
   * o PIX?", e a resposta certa é mandá-lo de novo — não repetir que ainda não
   * identificamos o pagamento e ficar por isso mesmo.
   */
  | 'reenviar_sinal'
  /** 045: sinal pago — gravar pessoa, lead e venda no ERP. */
  | 'registrar_venda';

export interface Transicao {
  readonly estado: EstadoFluxo;
  readonly mensagens: readonly string[];
  readonly efeito: Efeito;
  /** Presente em `escalar_alcada`: o que o lead pediu. */
  readonly valorPedidoCentavos?: number;
}

/** Opções apresentadas de uma vez (tier × modelo distintos, mais baratas primeiro). */
export const MAX_OPCOES = 3;
export const PERIODOS_VALIDOS: readonly number[] = [1, 2, 3];
export const MAX_PESSOAS = 12;

/**
 * Piso da alçada em centavos, aritmética INTEIRA (nada de float em dinheiro).
 * Mesma fórmula do SQL de `comercial.condicoes_cota`: divisão inteira de
 * positivo = floor.
 */
export function pisoCentavos(tabelaCentavos: number, bps: number): number {
  if (!Number.isInteger(tabelaCentavos) || tabelaCentavos < 0) {
    throw new Error('tabela deve ser inteiro em centavos');
  }
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    throw new Error('bps deve ser inteiro em 0..10000');
  }
  return Math.floor((tabelaCentavos * (10_000 - bps)) / 10_000);
}

export function cotaEscolhida(
  estado: Pick<EstadoFluxo, 'opcoes' | 'escolha'>,
): CotaDisponivel | null {
  if (estado.escolha === null) return null;
  return estado.opcoes[estado.escolha] ?? null;
}

/** Valor da oferta vigente — tabela ou piso — ou null se ainda não há oferta. */
export function valorOfertadoCentavos(
  estado: Pick<EstadoFluxo, 'opcoes' | 'escolha' | 'oferta'> &
    Partial<Pick<EstadoFluxo, 'valorAcordadoCentavos'>>,
  bps: number,
): number | null {
  // 015b: o que um humano decidiu vale mais que a tabela e que o piso
  if (estado.valorAcordadoCentavos != null) return estado.valorAcordadoCentavos;
  const cota = cotaEscolhida(estado);
  if (!cota || !estado.oferta) return null;
  return estado.oferta === 'tabela'
    ? cota.valorTabelaCentavos
    : pisoCentavos(cota.valorTabelaCentavos, bps);
}

/**
 * Do estoque lido pelo catálogo, as opções que casam o perfil: capacidade ≥
 * pessoas, períodos iguais; uma por tier×modelo (a mais barata); até MAX_OPCOES.
 */
export function selecionarOpcoes(
  cotas: readonly CotaDisponivel[],
  perfil: Pick<Perfil, 'pessoas' | 'periodos'>,
): CotaDisponivel[] {
  const vistas = new Set<string>();
  const out: CotaDisponivel[] = [];
  const ordenadas = [...cotas].sort((a, b) => a.valorTabelaCentavos - b.valorTabelaCentavos);
  for (const c of ordenadas) {
    if (perfil.pessoas !== null && c.capacidade < perfil.pessoas) continue;
    if (perfil.periodos !== null && c.periodos !== perfil.periodos) continue;
    const chave = `${c.tier}|${c.modelo}`;
    if (vistas.has(chave)) continue;
    vistas.add(chave);
    out.push(c);
    if (out.length >= MAX_OPCOES) break;
  }
  return out;
}
