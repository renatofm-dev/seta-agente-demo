import type { MensagemThread } from './console-api';

/**
 * Helpers puros da tela de atendimento (#45) — testados em test/formatos.test.ts.
 * Tudo recebe `agora` explícito para os testes não dependerem do relógio.
 */

/** Iniciais para o avatar: 2 primeiras palavras com letra; fallback "?". */
export function iniciais(nome: string | null | undefined): string {
  const palavras = (nome ?? '').split(/\s+/).filter((p) => /\p{L}|\d/u.test(p));
  const letras = palavras.slice(0, 2).map((p) => [...p][0]?.toUpperCase() ?? '');
  return letras.join('') || '?';
}

/** wa_id E.164 sem "+" → telefone legível (BR: +55 11 99999-0001). */
export function telefoneBonito(waId: string | null | undefined): string {
  const d = (waId ?? '').replaceAll(/\D/g, '');
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) {
    const ddd = d.slice(2, 4);
    const corpo = d.slice(4);
    return `+55 ${ddd} ${corpo.slice(0, -4)}-${corpo.slice(-4)}`;
  }
  return d ? `+${d}` : '—';
}

const MESMO_DIA = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

const ontemDe = (agora: Date) =>
  new Date(agora.getFullYear(), agora.getMonth(), agora.getDate() - 1);

const hhmm = (d: Date) =>
  `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

const ddmm = (d: Date) =>
  `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;

/** Horário da lista: hoje → HH:MM; ontem → "Ontem"; antes → DD/MM. */
export function horarioLista(iso: string, agora: Date = new Date()): string {
  const d = new Date(iso);
  if (MESMO_DIA(d, agora)) return hhmm(d);
  if (MESMO_DIA(d, ontemDe(agora))) return 'Ontem';
  return ddmm(d);
}

/** Separador de dia na thread: "Hoje" | "Ontem" | DD/MM/AAAA. */
export function separadorDia(iso: string, agora: Date = new Date()): string {
  const d = new Date(iso);
  if (MESMO_DIA(d, agora)) return 'Hoje';
  if (MESMO_DIA(d, ontemDe(agora))) return 'Ontem';
  return `${ddmm(d)}/${d.getFullYear()}`;
}

export type EstadoJanela =
  | { estado: 'aberta' }
  | { estado: 'fechando'; rotulo: string }
  | { estado: 'fechada' };

const AVISO_JANELA_MS = 2 * 3600 * 1000;

/** Janela de 24h da Meta: aberta, perto de fechar (≤2h) ou fechada. */
export function estadoJanela(expiraEm: string | null, agora: Date = new Date()): EstadoJanela {
  if (!expiraEm) return { estado: 'fechada' };
  const resta = new Date(expiraEm).getTime() - agora.getTime();
  if (resta <= 0) return { estado: 'fechada' };
  if (resta > AVISO_JANELA_MS) return { estado: 'aberta' };
  const min = Math.ceil(resta / 60_000);
  const rotulo =
    min >= 60
      ? `fecha em ${Math.floor(min / 60)}h${min % 60 > 0 ? `${min % 60}min` : ''}`
      : `fecha em ${min}min`;
  return { estado: 'fechando', rotulo };
}

/**
 * Mescla páginas da thread sem duplicar (refetch da página recente convive com
 * páginas antigas já carregadas). Ordena por criadoEm e desempata por id.
 */
export function mesclarMensagens(
  existentes: readonly MensagemThread[],
  novas: readonly MensagemThread[],
): MensagemThread[] {
  const porId = new Map<string, MensagemThread>();
  for (const m of existentes) porId.set(m.id, m);
  for (const m of novas) porId.set(m.id, m); // nova versão vence (status atualiza)
  return [...porId.values()].sort((a, b) => {
    const dt = new Date(a.criadoEm).getTime() - new Date(b.criadoEm).getTime();
    return dt !== 0 ? dt : a.id.localeCompare(b.id);
  });
}

/**
 * O prefixo `*Nome*` da Parte B se aplica quando a ÚLTIMA saída não é do
 * próprio atendente — espelha a regra do servidor para o contador de
 * caracteres descontar certo.
 */
export function prefixoSeAplica(
  mensagens: readonly MensagemThread[],
  meuUserId: string | null | undefined,
): boolean {
  const ultimaSaida = [...mensagens].reverse().find((m) => m.autor !== 'contato');
  if (!ultimaSaida || !meuUserId) return true;
  return !(ultimaSaida.autor === 'atendente' && ultimaSaida.atendenteId === meuUserId);
}
