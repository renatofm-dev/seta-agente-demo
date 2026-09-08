import type { DisparoResumo } from './console-api';

/** Helpers puros das telas de Campanhas (disparos da 013 vistos como campanha). */

/** Substitui {{1}}..{{N}} do corpo pelos valores (ou pelo placeholder quando vazio). */
export function preencherModelo(corpo: string, valores: readonly string[]): string {
  return corpo.replaceAll(/\{\{(\d+)\}\}/g, (_, n: string) => {
    const v = valores[Number(n) - 1];
    return v && v.trim().length > 0 ? v : `[variável ${n}]`;
  });
}

/** Variáveis {{1}}..{{N}} do corpo (espelho client-side do wa-meta). */
export function variaveisDoCorpo(corpo: string): number[] {
  const ns = [...corpo.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
  return [...new Set(ns)].sort((a, b) => a - b);
}

export interface FunilCampanha {
  destinatarios: number;
  enviadas: number;
  entregues: number;
  lidas: number;
  falhas: number;
}

/** Funil de uma campanha: enviadas = tudo que saiu da fila; entregues inclui as lidas. */
export function funilDe(
  d: Pick<DisparoResumo, 'total' | 'pendentes' | 'entregues' | 'lidos' | 'falhas'>,
): FunilCampanha {
  return {
    destinatarios: d.total,
    enviadas: d.total - d.pendentes,
    entregues: d.entregues + d.lidos,
    lidas: d.lidos,
    falhas: d.falhas,
  };
}

/** Soma dos funis das campanhas criadas no mês de `agora`. */
export function resumoDoMes(disparos: readonly DisparoResumo[], agora: Date = new Date()) {
  const doMes = disparos.filter((d) => {
    const dt = new Date(d.criado_em);
    return dt.getFullYear() === agora.getFullYear() && dt.getMonth() === agora.getMonth();
  });
  const soma = doMes.reduce(
    (acc, d) => {
      const f = funilDe(d);
      return {
        destinatarios: acc.destinatarios + f.destinatarios,
        enviadas: acc.enviadas + f.enviadas,
        entregues: acc.entregues + f.entregues,
        lidas: acc.lidas + f.lidas,
        falhas: acc.falhas + f.falhas,
      };
    },
    { destinatarios: 0, enviadas: 0, entregues: 0, lidas: 0, falhas: 0 },
  );
  return {
    ...soma,
    campanhas: doMes.length,
    ativas: disparos.filter((d) => d.status === 'enviando').length,
  };
}

/** CSV simples (RFC 4180) para exportar destinatários. */
export function paraCsv(linhas: readonly (string | number | null | undefined)[][]): string {
  const celula = (v: string | number | null | undefined) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n;]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return linhas.map((l) => l.map(celula).join(';')).join('\n');
}
