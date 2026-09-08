import type { MensagemThread } from './console-api';

/**
 * Helpers puros das telas do console — testados em test/formatos.test.ts.
 * Tudo recebe `agora` explícito para os testes não dependerem do relógio.
 */

/** Iniciais para o avatar: 2 primeiras palavras com letra; fallback "?". */
export function iniciais(nome: string | null | undefined): string {
  const palavras = (nome ?? '').split(/\s+/).filter((p) => /\p{L}|\d/u.test(p));
  const letras = palavras.slice(0, 2).map((p) => [...p][0]?.toUpperCase() ?? '');
  return letras.join('') || '?';
}

/** 014: centavos → "R$ 1.234,56" (espelho client-side do @seta/cobranca). */
export function reaisDeCentavos(centavos: number): string {
  const abs = Math.abs(centavos);
  const inteiros = Math.floor(abs / 100)
    .toString()
    .replaceAll(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${centavos < 0 ? '-' : ''}R$ ${inteiros},${String(abs % 100).padStart(2, '0')}`;
}

/** YYYY-MM-DD → DD/MM/AAAA (datas do PSP chegam como string de data). */
export function dataCurta(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '');
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '—';
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

/** Telefone mascarado das listas de campanha (regra de pseudonimização): "9…-0002". */
export function telefoneMascarado(waId: string | null | undefined): string {
  const d = (waId ?? '').replaceAll(/\D/g, '');
  if (d.length < 5) return '—';
  const corpo = d.startsWith('55') && (d.length === 12 || d.length === 13) ? d.slice(4) : d;
  return `${corpo[0]}…-${corpo.slice(-4)}`;
}

/** Nome para exibir: o do cadastro de contato; sem ele, o telefone. */
export function nomeExibicao(nome: string | null | undefined, waId: string | null | undefined) {
  return nome && nome.trim().length > 0 ? nome : telefoneBonito(waId);
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

/** Só a hora (HH:MM) — rodapé dos balões e linhas do tempo. */
export function hora(iso: string): string {
  return hhmm(new Date(iso));
}

/** DD/MM HH:MM — "gerada 12/09 10:43". */
export function dataHoraCurta(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${ddmm(d)} ${hhmm(d)}`;
}

/** DD/MM/AAAA HH:MM. */
export function dataHoraCompleta(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${ddmm(d)}/${d.getFullYear()} ${hhmm(d)}`;
}

/** Separador de dia na thread: "Hoje" | "Ontem" | DD/MM/AAAA. */
export function separadorDia(iso: string, agora: Date = new Date()): string {
  const d = new Date(iso);
  if (MESMO_DIA(d, agora)) return 'Hoje';
  if (MESMO_DIA(d, ontemDe(agora))) return 'Ontem';
  return `${ddmm(d)}/${d.getFullYear()}`;
}

/** Duração humana: "45 s", "12 min", "1h20min", "2 d". */
export function duracao(segundos: number | null | undefined): string {
  if (segundos === null || segundos === undefined || !Number.isFinite(segundos)) return '—';
  const s = Math.max(0, Math.round(segundos));
  if (s < 60) return `${s} s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h${min % 60 > 0 ? `${min % 60}min` : ''}`;
  return `${Math.floor(h / 24)} d`;
}

/** "agora", "há 8 min", "há 2 h", "ontem", "há 3 dias". */
export function tempoRelativo(iso: string | null | undefined, agora: Date = new Date()): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const diff = Math.max(0, agora.getTime() - d.getTime());
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24 && MESMO_DIA(d, agora)) return `há ${h} h`;
  if (MESMO_DIA(d, ontemDe(agora))) return 'ontem';
  const dias = Math.max(2, Math.round(diff / 86_400_000));
  return `há ${dias} dias`;
}

/** Percentual inteiro de n sobre total: (41, 318) → "13%"; total 0 → "—". */
export function porcentagem(n: number, total: number): string {
  if (!total) return '—';
  return `${Math.round((n / total) * 100)}%`;
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

/** Prefixo do preview na lista de conversas: quem falou por último. */
export function prefixoAutor(autor: string, atendenteNome?: string | null): string {
  if (autor === 'bot') return 'Agente: ';
  if (autor === 'atendente') return `${atendenteNome?.split(' ')[0] ?? 'Atendente'}: `;
  if (autor === 'campanha') return 'Campanha: ';
  return '';
}

/**
 * Códigos de pagamento (PIX copia-e-cola, linha digitável) vão em mono e sem
 * quebra estranha: heurística sobre o texto, já que a mensagem não traz o tipo.
 */
export function ehCodigoPagamento(texto: string): boolean {
  const t = texto.trim();
  if (t.length === 0) return false;
  if (t.startsWith('000201') || t.includes('br.gov.bcb.pix')) return true;
  if (/^[\d.\s]{40,}$/.test(t)) return true; // linha digitável do boleto
  return !/\s/.test(t) && t.length >= 60;
}

/** Texto do balão do atendente sem o prefixo `*Nome*` (a UI mostra o nome na etiqueta). */
export function semPrefixoAtendente(texto: string): string {
  return texto.replace(/^\*[^*\n]+\*\n\n/, '');
}
