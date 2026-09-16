import { z } from 'zod';
import { reaisParaCentavos } from './tipos.js';

/**
 * Reserva (utilização de contrato) no TS Explorer — 038.
 *
 * Duas decisões de contrato moram aqui:
 *
 *  1. **O caminho é o de OPERADOR.** `PainelDoCliente/CriarSolicitacaoReserva`
 *     devolve 200 com corpo vazio: sem id não há como confirmar nem cancelar.
 *     Então é `CriarUtilizacaoContrato` → `ConfirmarUtilizacaoContrato/{id}`, e o
 *     agente aparece no ERP como operador — o que a auditoria exige.
 *  2. **Hóspedes vão no corpo da criação.** `CriarUtilizacaoContrato` aceita
 *     `ListaHospedes`, então criar+hóspedes é UMA escrita, não 1+N. É a maior
 *     redução possível da superfície de não-idempotência.
 */

// --- entradas ---------------------------------------------------------------

export const HospedeInputSchema = z.object({
  nome: z.string().min(1).max(120),
  sobrenome: z.string().max(120).nullish(),
  /**
   * CPF do hóspede. Vem SEMPRE do parser determinístico sobre o texto cru do
   * cotista (ou do cadastro do titular) — nunca da saída estruturada do modelo:
   * o decorator de anonimização devolve token desconhecido intacto, e um
   * `[CPF_1]` gravado no ERP é dado errado num sistema de terceiro.
   */
  cpf: z.string().max(14).nullish(),
  faixaEtaria: z.number().int().positive().default(1),
  principal: z.boolean().default(false),
  /** O TSE pede; o espelho não tem o dado. Vai nulo — ver pergunta aberta no PR. */
  sexo: z.string().max(20).nullish(),
});
export type HospedeInput = z.input<typeof HospedeInputSchema>;

export const SimularUtilizacaoInputSchema = z.object({
  contratoId: z.string().min(1),
  idHotel: z.number().int().positive(),
  idTipoUh: z.number().int().positive(),
  /** `YYYY-MM-DD`. */
  checkIn: z.iso.date(),
  checkOut: z.iso.date(),
  pagantes: z.number().int().min(1).max(20).default(1),
});
export type SimularUtilizacaoInput = z.input<typeof SimularUtilizacaoInputSchema>;

export const CriarUtilizacaoInputSchema = SimularUtilizacaoInputSchema.extend({
  adultos: z.number().int().min(1).max(20),
  criancas: z.number().int().min(0).max(20).default(0),
  hospedes: z.array(HospedeInputSchema).default([]),
});
export type CriarUtilizacaoInput = z.input<typeof CriarUtilizacaoInputSchema>;

// --- saídas -----------------------------------------------------------------

export interface OpcaoErp {
  readonly id: number;
  readonly descricao: string;
}

export interface DiariaSimulada {
  /** `YYYY-MM-DD`. */
  readonly dia: string;
  readonly bloqueado: boolean;
  readonly periodo: string;
  readonly custoPontos: number;
  readonly taxaCentavos: number;
}

export interface SimulacaoErp {
  readonly diarias: readonly DiariaSimulada[];
  readonly custoPontos: number;
  readonly taxaCentavos: number;
  /** Dias que o ERP recusa — é com eles que o agente explica, sem inventar. */
  readonly bloqueadas: readonly string[];
}

export interface UtilizacaoErp {
  readonly id: string;
  readonly status: string;
  readonly confirmada: boolean;
  readonly custoPontos: number;
  readonly taxaCentavos: number;
  readonly checkIn: string;
  readonly checkOut: string;
  readonly hotel: string | null;
  readonly tipoUh: string | null;
  readonly idHotel: number | null;
  readonly idTipoUh: number | null;
  readonly pagantes: number;
  /** Quem pediu, do lado do TSE — o que distingue robô de humano. */
  readonly operador: string | null;
}

// --- Zod das respostas do TSE (validados contra as fixtures, sem rede) -------

export const OpcaoHotelSchema = z.object({
  IdHotelNegocio: z.number().int(),
  Descricao: z.string(),
});
export const OpcaoHotelPainelSchema = z.object({
  IdEdificioHotel: z.number().int(),
  Descricao: z.string(),
});
export const OpcaoTipoUhSchema = z.object({
  IdTipoUnidadeHoteleira: z.number().int(),
  Descricao: z.string(),
});

export const DiariaSchema = z.object({
  DataDiaria: z.string(),
  Bloqueado: z.boolean(),
  DescricaoPeriodo: z.string(),
  CustoPorDiaria: z.number(),
  ValorTaxaPeriodo: z.number(),
});

export const UtilizacaoSchema = z.object({
  IdUtilizacaoContrato: z.number().int(),
  Status: z.string().nullish(),
  CustoTotalPontos: z.number(),
  ValorTotalTaxaManutencao: z.number(),
  DataCheckIn: z.string(),
  DataCheckOut: z.string(),
  HotelReservaDescricao: z.string().nullish(),
  TipoUhDescricao: z.string().nullish(),
  QtdAdultos: z.number().int(),
  QtdCriancas: z.number().int(),
});

/** Uma linha de `MinhasUtilizacoesContrato` — a base do read-back por chave natural. */
export const UtilizacaoListadaSchema = z.object({
  IdUtilizacaoContrato: z.number().int(),
  Status: z.string().nullish(),
  UtilizacaoConfirmada: z.boolean(),
  CustoTotalPontos: z.number(),
  DataCheckIn: z.string(),
  DataCheckOut: z.string(),
  IdHotelReserva: z.number().int().nullish(),
  HotelReserva: z.string().nullish(),
  IdTipoUhTarifas: z.number().int().nullish(),
  TipoUhTarifas: z.string().nullish(),
  QtdPagantes: z.number().int(),
  OperadorRespSolicitacao: z.string().nullish(),
});

export const MinhasUtilizacoesSchema = z.object({
  Utilizacoes: z.array(UtilizacaoListadaSchema),
  TotalPaginas: z.number().int().nonnegative(),
  SaldoPontosGeral: z.number(),
  QtdPontosContratados: z.number(),
});

// --- conversões -------------------------------------------------------------

/** `YYYY-MM-DD` de uma data do TSE (que vem com hora e offset). */
export const diaDe = (texto: string): string => texto.slice(0, 10);

/** O TSE fala decimal; daqui para dentro é centavo inteiro, sempre. */
export function paraSimulacao(bruto: unknown): SimulacaoErp {
  const diarias = z
    .array(DiariaSchema)
    .parse(bruto)
    .map((d) => ({
      dia: diaDe(d.DataDiaria),
      bloqueado: d.Bloqueado,
      periodo: d.DescricaoPeriodo,
      custoPontos: d.CustoPorDiaria,
      taxaCentavos: reaisParaCentavos(d.ValorTaxaPeriodo),
    }));
  return {
    diarias,
    custoPontos: diarias.reduce((a, d) => a + d.custoPontos, 0),
    taxaCentavos: diarias.reduce((a, d) => a + d.taxaCentavos, 0),
    bloqueadas: diarias.filter((d) => d.bloqueado).map((d) => d.dia),
  };
}

export function paraUtilizacao(bruto: unknown): UtilizacaoErp {
  const u = UtilizacaoSchema.parse(bruto);
  return {
    id: String(u.IdUtilizacaoContrato),
    status: u.Status ?? '',
    confirmada: (u.Status ?? '').toUpperCase() === 'CONFIRMADA',
    custoPontos: u.CustoTotalPontos,
    taxaCentavos: reaisParaCentavos(u.ValorTotalTaxaManutencao),
    checkIn: diaDe(u.DataCheckIn),
    checkOut: diaDe(u.DataCheckOut),
    hotel: u.HotelReservaDescricao ?? null,
    tipoUh: u.TipoUhDescricao ?? null,
    idHotel: null,
    idTipoUh: null,
    pagantes: u.QtdAdultos + u.QtdCriancas,
    operador: null,
  };
}

export function paraUtilizacaoListada(u: z.infer<typeof UtilizacaoListadaSchema>): UtilizacaoErp {
  return {
    id: String(u.IdUtilizacaoContrato),
    status: u.Status ?? '',
    confirmada: u.UtilizacaoConfirmada,
    custoPontos: u.CustoTotalPontos,
    taxaCentavos: 0, // a listagem não traz a taxa; quem precisa lê a utilização
    checkIn: diaDe(u.DataCheckIn),
    checkOut: diaDe(u.DataCheckOut),
    hotel: u.HotelReserva ?? null,
    tipoUh: u.TipoUhTarifas ?? null,
    idHotel: u.IdHotelReserva ?? null,
    idTipoUh: u.IdTipoUhTarifas ?? null,
    pagantes: u.QtdPagantes,
    operador: u.OperadorRespSolicitacao ?? null,
  };
}

/**
 * Chave NATURAL de uma reserva. `CriarUtilizacaoContrato` não tem campo de
 * referência externa (a 036 pôde usar `CodigoAutorizacao`; aqui não há
 * equivalente), então é por esta combinação que o worker reconhece a própria
 * escrita quando a resposta se perde.
 */
export function mesmaReserva(
  u: UtilizacaoErp,
  alvo: { checkIn: string; checkOut: string; idHotel: number; idTipoUh: number; pagantes: number },
): boolean {
  return (
    u.checkIn === alvo.checkIn &&
    u.checkOut === alvo.checkOut &&
    u.idHotel === alvo.idHotel &&
    u.idTipoUh === alvo.idTipoUh &&
    u.pagantes === alvo.pagantes &&
    u.status.toUpperCase() !== 'CANCELADA'
  );
}
