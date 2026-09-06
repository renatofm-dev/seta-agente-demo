/**
 * Tipos do port de anonimização (016). Um Detector acha PII num texto; o
 * Anonimizador troca cada achado por um token estável do Cofre; o decorator
 * do AIProvider aplica isso em toda mensagem antes de sair para o provedor.
 */

export const TIPOS_PII = [
  'cpf',
  'cnpj',
  'telefone',
  'email',
  'cep',
  'cartao',
  'placa',
  'nome',
] as const;
export type TipoPii = (typeof TIPOS_PII)[number];

/** Rótulo do token que a LLM vê: `[NOME_1]`, `[CPF_2]`… */
export const ROTULO_POR_TIPO: Readonly<Record<TipoPii, string>> = {
  cpf: 'CPF',
  cnpj: 'CNPJ',
  telefone: 'TEL',
  email: 'EMAIL',
  cep: 'CEP',
  cartao: 'CARTAO',
  placa: 'PLACA',
  nome: 'NOME',
};

export interface Deteccao {
  readonly tipo: TipoPii;
  /** Offsets no texto original, [inicio, fim). */
  readonly inicio: number;
  readonly fim: number;
  /** Trecho exatamente como aparece no texto. */
  readonly valor: string;
  /** Detector que achou (para o trace e para depurar). */
  readonly detector: string;
}

export interface Detector {
  readonly nome: string;
  detectar(texto: string): Promise<readonly Deteccao[]> | readonly Deteccao[];
}

export type Contagem = Partial<Record<TipoPii, number>>;

export interface EstatisticasAnonimizacao {
  /** Substituições por tipo — contagem, nunca o valor. */
  readonly substituicoes: Contagem;
  readonly total: number;
  readonly latenciaMs: number;
  /** Tokens na resposta da LLM que não existiam no cofre (inventados). */
  readonly tokensDesconhecidos: number;
}

export interface EventoAnonimizacao extends EstatisticasAnonimizacao {
  readonly traceId?: string;
  readonly operacao: 'chat' | 'embed';
  readonly modelo: string;
}

export type SinkAnonimizacao = (evento: EventoAnonimizacao) => void;
