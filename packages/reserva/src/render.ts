import type { EstadoFluxo, OpcaoReserva, SimulacaoReserva } from './tipos.js';
import { faltamHospedes, noites } from './tipos.js';

/**
 * Textos do fluxo de reserva. Determinísticos, em pt-BR, no tom de WhatsApp —
 * e, como em `packages/cobranca`, NÃO são rascunho de LLM: por isso não passam
 * pelo guardrail de saída. Todo valor aqui veio do ERP pela simulação.
 */

/**
 * Formatação à mão, igual à de `packages/cobranca`: `toLocaleString` com
 * `style: 'currency'` mete um espaço NÃO-QUEBRÁVEL (U+00A0) entre `R$` e o
 * número, e isso vaza para o WhatsApp e para as asserções dos testes.
 */
export function milhar(n: number): string {
  return Math.trunc(n)
    .toString()
    .replaceAll(/\B(?=(\d{3})+(?!\d))/g, '.');
}

export function formatarReais(centavos: number): string {
  const negativo = centavos < 0;
  const abs = Math.abs(centavos);
  return `${negativo ? '-' : ''}R$ ${milhar(abs / 100)},${(abs % 100).toString().padStart(2, '0')}`;
}

/** `2027-05-10` → `10/05`. */
export function formatarDia(iso: string): string {
  const [, m, d] = iso.split('-');
  return `${d}/${m}`;
}

export function formatarPeriodo(checkIn: string, checkOut: string): string {
  return `${formatarDia(checkIn)} a ${formatarDia(checkOut)}`;
}

const listar = (opcoes: readonly OpcaoReserva[]): string =>
  opcoes.map((o, i) => `${i + 1}. ${o.descricao}`).join('\n');

export const TEXTO_PERIODO =
  'Claro! Para qual período você quer reservar? Me diga a data de entrada e a de saída ' +
  '(por exemplo: "de 10/05 a 13/05").';

export const TEXTO_PERIODO_INVALIDO =
  'Não consegui entender as datas. Pode me dizer a entrada e a saída assim: "de 10/05 a 13/05"?';

export function textoHoteis(hoteis: readonly OpcaoReserva[]): string {
  return `Em qual você quer ficar?\n${listar(hoteis)}\n\nResponda com o número.`;
}

export function textoTiposUh(tipos: readonly OpcaoReserva[]): string {
  return `Que tipo de unidade?\n${listar(tipos)}\n\nResponda com o número.`;
}

export const TEXTO_PAGANTES = 'Quantas pessoas vão? Me diga quantos adultos e quantas crianças.';

/** A simulação: pontos e taxa SEMPRE do ERP, nunca calculados aqui. */
export function textoSimulacao(estado: EstadoFluxo, s: SimulacaoReserva): string {
  const periodo = formatarPeriodo(estado.checkIn as string, estado.checkOut as string);
  const n = noites(estado.checkIn as string, estado.checkOut as string);
  return (
    `Consegui reservar ${estado.tipoUh} no ${estado.hotel}, de ${periodo} ` +
    `(${n} ${n === 1 ? 'noite' : 'noites'}).\n\n` +
    `• Pontos: ${milhar(s.custoPontos)}\n` +
    `• Taxa de manutenção: ${formatarReais(s.taxaCentavos)}`
  );
}

export function textoHospedes(estado: EstadoFluxo): string {
  const faltam = faltamHospedes(estado);
  if (faltam === 0) return TEXTO_HOSPEDES_PRONTOS;
  const quem = estado.hospedes.length === 0 ? 'a primeira pessoa' : 'a próxima pessoa';
  return (
    `Agora preciso dos hóspedes. Me diga o nome completo e o CPF d${quem} ` + `(faltam ${faltam}).`
  );
}

export const TEXTO_HOSPEDES_PRONTOS = 'Todos os hóspedes anotados.';

export const TEXTO_CPF_INVALIDO =
  'Esse CPF não parece válido. Pode conferir e mandar de novo, junto com o nome completo?';

export function textoConfirmacao(estado: EstadoFluxo): string {
  const s = estado.simulacao as SimulacaoReserva;
  const hospedes = estado.hospedes.map((h) => `• ${h.nome}${h.sobrenome ? ` ${h.sobrenome}` : ''}`);
  return (
    `Confere pra mim:\n\n` +
    `• ${estado.hotel} — ${estado.tipoUh}\n` +
    `• ${formatarPeriodo(estado.checkIn as string, estado.checkOut as string)}\n` +
    `• ${estado.adultos} adulto(s)${(estado.criancas ?? 0) > 0 ? ` e ${estado.criancas} criança(s)` : ''}\n` +
    `${hospedes.join('\n')}\n\n` +
    `• Pontos: ${milhar(s.custoPontos)}\n` +
    `• Taxa de manutenção: ${formatarReais(s.taxaCentavos)}\n\n` +
    `Posso confirmar?`
  );
}

export const TEXTO_CRIANDO = 'Confirmado! Estou registrando a reserva, já te aviso.';

export function textoAprovacao(taxaCentavos: number): string {
  return (
    `A taxa de manutenção desta reserva é ${formatarReais(taxaCentavos)}, acima do que consigo ` +
    `liberar sozinho. Encaminhei para um atendente aprovar — assim que sair, eu te aviso.`
  );
}

/** Os dois "não deu": ambos citam o dado do ERP e NÃO oferecem alternativa. */
export function textoPeriodoBloqueado(bloqueadas: readonly string[]): string {
  const dias = bloqueadas.map(formatarDia).join(', ');
  return (
    `Esse período não está disponível para utilização: ${dias}. ` +
    `Se quiser, me diga outras datas que eu consulto.`
  );
}

export function textoPontosInsuficientes(custo: number, saldo: number): string {
  return (
    `Esse período custa ${milhar(custo)} pontos e o seu contrato tem ` +
    `${milhar(saldo)} disponíveis. Se quiser, me diga um período menor que eu simulo.`
  );
}

export const TEXTO_SEM_HOTEIS =
  'Não encontrei nenhum hotel disponível para o seu contrato. Vou chamar um atendente.';

export const TEXTO_BLOQUEADO =
  'Reserva é assunto para um atendente no caso do seu contrato. Já estou chamando alguém.';

export const TEXTO_CANCELADO = 'Tudo bem, cancelei a reserva. Se quiser retomar, é só me chamar.';

export const TEXTO_NAO_ENTENDI = 'Não entendi. Pode repetir?';

export const TEXTO_FALHA_RESERVA =
  'Tive um problema para registrar sua reserva no sistema. Já acionei um atendente para concluir.';

export const TEXTO_RECUSADA =
  'Um atendente revisou a sua reserva e ela não pôde ser confirmada. Ele vai falar com você.';

/** Aviso de reserva criada, enviado pelo worker depois que o ERP confirma. */
export function textoReservaConfirmada(estado: {
  hotel: string | null;
  tipoUh: string | null;
  checkIn: string;
  checkOut: string;
  erpId: string | null;
}): string {
  return (
    `Reserva confirmada! ${estado.tipoUh ?? 'Unidade'} no ${estado.hotel ?? 'resort'}, ` +
    `de ${formatarPeriodo(estado.checkIn, estado.checkOut)}` +
    `${estado.erpId ? ` (nº ${estado.erpId})` : ''}.`
  );
}
