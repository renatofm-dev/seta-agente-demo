/**
 * Tradução de valor para o dialeto do TS Explorer (035). O simulador é fiel à
 * FORMA do fornecedor: PascalCase, decimal como número JSON e data com offset
 * de Brasília. Quem erra aqui faz o adapter (036) passar contra o dublê e
 * falhar contra o TSE real — que é o único jeito de esta frente dar errado.
 */

/** Brasília fixo: o Brasil não tem horário de verão desde 2019, e o TSE devolve -03:00 cravado. */
export const OFFSET_TSE = '-03:00';

/**
 * `numeric` volta do pg como string (o driver não arredonda em float por
 * decisão de precisão) e o TSE devolve número. 66.68, não "66.68".
 */
export function decimal(valor: string | number | null | undefined): number {
  if (valor === null || valor === undefined) return 0;
  return typeof valor === 'number' ? valor : Number(valor);
}

/**
 * Data do TSE: `YYYY-MM-DDT00:00:00-03:00`. A entrada vem como texto do
 * Postgres (`to_char`) — nunca como Date, para não passar pelo fuso do host.
 */
export function dataTse(dia: string | null | undefined): string | null {
  if (!dia) return null;
  return `${dia}T00:00:00${OFFSET_TSE}`;
}

/** Instante com hora (DataLancamento, DataConsultaSistema). */
export function instanteTse(texto: string | null | undefined): string | null {
  if (!texto) return null;
  return `${texto.replace(' ', 'T')}${OFFSET_TSE}`;
}

/** "agora" no fuso do TSE — o simulador nunca devolve UTC. */
export function agoraTse(): string {
  const partes = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date());
  return `${partes.replace(' ', 'T')}${OFFSET_TSE}`;
}

/** Hoje no fuso do TSE, como `YYYY-MM-DD` (base de Vencido/QtdDiasVencido). */
export function hojeTse(): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format(new Date());
}

/** Diferença em dias entre duas datas `YYYY-MM-DD` (b − a). */
export function diasEntre(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}
