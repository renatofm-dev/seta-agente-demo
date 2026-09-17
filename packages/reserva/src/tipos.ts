/**
 * Vocabulário do fluxo de reserva (038). Puro e síncrono: a máquina DECIDE,
 * o server EXECUTA. Nenhuma linha aqui fala com banco, ERP ou rede.
 */

export const ETAPAS = [
  'periodo',
  'hotel',
  'unidade',
  'pagantes',
  'hospedes',
  'confirmacao',
  'encerrado',
] as const;
export type Etapa = (typeof ETAPAS)[number];

/**
 * Motivos de encerramento. `criando` e `aguardando_aprovacao` são os dois
 * finais bons; os outros explicam por que a reserva não aconteceu — e três
 * deles (`periodo_bloqueado`, `pontos_insuficientes`, `sem_hoteis`) nascem de
 * dado do ERP, nunca de palpite.
 */
export const ENCERRAMENTOS = [
  'criando',
  'aguardando_aprovacao',
  'cancelado',
  'periodo_bloqueado',
  'pontos_insuficientes',
  'sem_hoteis',
  'bloqueado',
  'abandonado',
  'expirado',
] as const;
export type Encerramento = (typeof ENCERRAMENTOS)[number];

export interface OpcaoReserva {
  readonly id: number;
  readonly descricao: string;
}

export interface HospedeReserva {
  readonly nome: string;
  readonly sobrenome: string | null;
  /** Só chega aqui pelo parser determinístico sobre o texto CRU do cotista. */
  readonly cpf: string | null;
  readonly principal: boolean;
}

export interface DiariaReserva {
  readonly dia: string;
  readonly bloqueado: boolean;
  readonly periodo: string;
  readonly custoPontos: number;
  readonly taxaCentavos: number;
}

export interface SimulacaoReserva {
  readonly diarias: readonly DiariaReserva[];
  readonly custoPontos: number;
  readonly taxaCentavos: number;
  readonly bloqueadas: readonly string[];
}

export interface EstadoFluxo {
  readonly etapa: Etapa;
  readonly encerramento?: Encerramento;
  /** `YYYY-MM-DD`. */
  readonly checkIn?: string;
  readonly checkOut?: string;
  /** Snapshot do que foi MOSTRADO — a escolha se refere a ele, não a uma releitura. */
  readonly hoteis: readonly OpcaoReserva[];
  readonly idHotel?: number;
  readonly hotel?: string;
  readonly tiposUh: readonly OpcaoReserva[];
  readonly idTipoUh?: number;
  readonly tipoUh?: string;
  readonly adultos?: number;
  readonly criancas?: number;
  readonly hospedes: readonly HospedeReserva[];
  readonly simulacao?: SimulacaoReserva;
  readonly naoEntendi: number;
}

export type Acao =
  | { readonly tipo: 'periodo'; readonly checkIn: string; readonly checkOut: string }
  | { readonly tipo: 'escolher'; readonly indice: number }
  | { readonly tipo: 'pagantes'; readonly adultos: number; readonly criancas: number }
  | {
      readonly tipo: 'hospede';
      readonly nome: string;
      readonly sobrenome: string | null;
      readonly cpf: string | null;
    }
  | { readonly tipo: 'pronto' }
  | { readonly tipo: 'confirmar' }
  | { readonly tipo: 'cancelar' }
  | { readonly tipo: 'nao_entendi' };

/**
 * O que o SERVER resolveu antes de chamar a máquina. A máquina não consulta
 * nada: recebe, decide e devolve.
 */
export interface ContextoFluxo {
  readonly contratoStatus: 'ativo' | 'cancelado' | 'quitado' | null;
  readonly distratoEmAnalise: boolean;
  /** Pontos que o contrato ainda tem — vem do ERP. */
  readonly saldoPontos: number;
  /** Acima disto, a taxa de manutenção espera um humano. */
  readonly tetoTaxaCentavos: number;
  /** Titular do contrato: é ele o hóspede principal por padrão. */
  readonly titular: { readonly nome: string; readonly cpf: string | null };
  /** Capacidade do tipo de UH escolhido, quando conhecida. */
  readonly capacidade?: number;
}

/**
 * Canal ÚNICO de efeito colateral: a máquina devolve um verbo, o server executa
 * e devolve o resultado por uma das funções `apresentar*`.
 */
export const EFEITOS = [
  'nenhum',
  'buscar_hoteis',
  'buscar_tipos_uh',
  'simular',
  'criar',
  'criar_com_aprovacao',
  'escalar_bloqueio',
] as const;
export type Efeito = (typeof EFEITOS)[number];

export interface Transicao {
  readonly estado: EstadoFluxo;
  readonly mensagens: readonly string[];
  readonly efeito: Efeito;
}

export const ESTADO_INICIAL: EstadoFluxo = {
  etapa: 'periodo',
  hoteis: [],
  tiposUh: [],
  hospedes: [],
  naoEntendi: 0,
};

/** Noites entre check-in e check-out — o check-out não é diária. */
export function noites(checkIn: string, checkOut: string): number {
  return Math.max(
    0,
    Math.round(
      (Date.parse(`${checkOut}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`)) / 86_400_000,
    ),
  );
}

/** Quantos hóspedes ainda faltam para fechar a lotação declarada. */
export function faltamHospedes(estado: EstadoFluxo): number {
  const total = (estado.adultos ?? 0) + (estado.criancas ?? 0);
  return Math.max(0, total - estado.hospedes.length);
}
