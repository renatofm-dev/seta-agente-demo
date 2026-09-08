import type { Papel } from '@/components/ui/chip';
import { paraCsv } from './campanhas';
import type { LinhaRelatorioCampanha, RelatorioCampanhas } from './console-api';
import { porcentagem, reaisDeCentavos } from './formatos';

/**
 * Helpers puros do relatório de campanhas (017): formatação de bps, agrupamentos
 * por modelo e competência, comparação com a meta, insights e CSV. Sem React,
 * sem fetch — tudo testável em unidade.
 */

/** bps → "12,5%"; null → "—". */
export function pctDeBps(bps: number | null | undefined, casas = 1): string {
  if (bps === null || bps === undefined) return '—';
  return `${(bps / 100).toFixed(casas).replace('.', ',')}%`;
}

/** Diferença em pontos percentuais, com sinal: "+2,5 p.p.". */
export function ppDeBps(deltaBps: number, casas = 1): string {
  const v = (Math.abs(deltaBps) / 100).toFixed(casas).replace('.', ',');
  return `${deltaBps > 0 ? '+' : deltaBps < 0 ? '−' : ''}${v} p.p.`;
}

/** "YYYY-MM-DD" → "DD/MM/AAAA" sem passar por Date (sem deslocar o dia pelo fuso). */
export function diaLegivel(dia: string): string {
  const [y, m, d] = dia.split('-');
  return y && m && d ? `${d}/${m}/${y}` : dia;
}

const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

/** "2026-09" → "set/26". */
export function competenciaLegivel(competencia: string): string {
  const [y, m] = competencia.split('-');
  const mes = MESES[Number(m) - 1];
  return mes && y ? `${mes}/${y.slice(2)}` : competencia;
}

/** Soma dias a um YYYY-MM-DD (aritmética em UTC, sem fuso). */
export function somarDias(dia: string, n: number): string {
  const [y, m, d] = dia.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Primeiro e último dia de uma competência "YYYY-MM". */
export function limitesDaCompetencia(competencia: string): { de: string; ate: string } {
  const [y, m] = competencia.split('-').map(Number) as [number, number];
  const de = `${competencia}-01`;
  const proximo = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  return { de, ate: somarDias(proximo, -1) };
}

/** Hoje (YYYY-MM-DD) no fuso do navegador. */
export function hojeLocal(agora: Date = new Date()): string {
  return agora.toLocaleDateString('en-CA');
}

export function horasLegiveis(h: number | null): string {
  if (h === null) return '—';
  if (h < 1) return 'menos de 1 h';
  if (h < 48) return `${Math.round(h)} h`;
  return `${(h / 24).toFixed(1).replace('.', ',')} dias`;
}

export type SituacaoMeta = 'acima' | 'abaixo' | 'sem_dados';

export function situacaoMeta(conversaoBps: number | null, metaBps: number): SituacaoMeta {
  if (conversaoBps === null) return 'sem_dados';
  return conversaoBps >= metaBps ? 'acima' : 'abaixo';
}

export const SITUACAO_META: Record<SituacaoMeta, { rotulo: string; papel: Papel }> = {
  acima: { rotulo: 'Na meta', papel: 'ok' },
  abaixo: { rotulo: 'Abaixo da meta', papel: 'risk' },
  sem_dados: { rotulo: 'Sem entrega', papel: 'off' },
};

export interface Agregado {
  chave: string;
  campanhas: number;
  enviadas: number;
  entregues: number;
  responderam: number;
  pagas: number;
  valorRecuperadoCentavos: number;
  /** pagas ÷ entregues em bps; null sem entrega. */
  conversaoBps: number | null;
  /** Meta ponderada pelas entregas; sem entrega, a global. */
  metaBps: number;
}

export function agruparPor(
  campanhas: readonly LinhaRelatorioCampanha[],
  chaveDe: (c: LinhaRelatorioCampanha) => string,
  metaGlobalBps: number,
): Agregado[] {
  const grupos = new Map<string, LinhaRelatorioCampanha[]>();
  for (const c of campanhas) {
    const k = chaveDe(c);
    const g = grupos.get(k);
    if (g) g.push(c);
    else grupos.set(k, [c]);
  }
  return [...grupos.entries()].map(([chave, itens]) => {
    const soma = (f: (c: LinhaRelatorioCampanha) => number) => itens.reduce((s, c) => s + f(c), 0);
    const entregues = soma((c) => c.entregues);
    const pagas = soma((c) => c.pagas);
    return {
      chave,
      campanhas: itens.length,
      enviadas: soma((c) => c.enviadas),
      entregues,
      responderam: soma((c) => c.responderam),
      pagas,
      valorRecuperadoCentavos: soma((c) => c.valorRecuperadoCentavos),
      conversaoBps: entregues > 0 ? Math.round((pagas * 10_000) / entregues) : null,
      metaBps:
        entregues > 0
          ? Math.round(soma((c) => c.metaBps * c.entregues) / entregues)
          : metaGlobalBps,
    };
  });
}

/** Modelos do melhor para o pior (sem entrega por último). */
export function porModelo(
  campanhas: readonly LinhaRelatorioCampanha[],
  metaGlobalBps: number,
): Agregado[] {
  return agruparPor(campanhas, (c) => c.modelo, metaGlobalBps).sort(
    (a, b) => (b.conversaoBps ?? -1) - (a.conversaoBps ?? -1),
  );
}

/** Competências em ordem cronológica. */
export function porCompetencia(
  campanhas: readonly LinhaRelatorioCampanha[],
  metaGlobalBps: number,
): Agregado[] {
  return agruparPor(campanhas, (c) => c.competencia, metaGlobalBps).sort((a, b) =>
    a.chave.localeCompare(b.chave),
  );
}

export interface Insight {
  tom: Papel;
  texto: string;
}

/** Leitura em prosa do relatório — o que o gestor perguntaria olhando os números. */
export function insights(rel: RelatorioCampanhas): Insight[] {
  const t = rel.totais;
  const out: Insight[] = [];
  if (t.campanhas === 0) {
    return [{ tom: 'off', texto: 'Nenhuma campanha no período com esses filtros.' }];
  }

  if (t.conversaoBps === null) {
    out.push({
      tom: 'off',
      texto: `Nenhuma mensagem entregue ainda: sem base para medir conversão (meta ${pctDeBps(t.metaBps)}).`,
    });
  } else {
    const d = t.conversaoBps - t.metaBps;
    out.push({
      tom: d >= 0 ? 'ok' : 'risk',
      texto: `Conversão de ${pctDeBps(t.conversaoBps)} contra meta de ${pctDeBps(t.metaBps)}: ${ppDeBps(Math.abs(d)).replace(/^\+/, '')} ${d >= 0 ? 'acima' : 'abaixo'} da meta.`,
    });
  }

  const a = rel.anterior;
  if (t.conversaoBps !== null && a.totais.conversaoBps !== null) {
    const d = t.conversaoBps - a.totais.conversaoBps;
    out.push({
      tom: d > 0 ? 'ok' : d < 0 ? 'risk' : 'off',
      texto: `${ppDeBps(d)} em relação ao período anterior (${diaLegivel(a.de)} a ${diaLegivel(a.ate)}: ${pctDeBps(a.totais.conversaoBps)}).`,
    });
  } else if (a.totais.campanhas === 0) {
    out.push({ tom: 'off', texto: 'Sem campanhas no período anterior para comparar.' });
  }

  const comBase = [...rel.campanhas]
    .filter((c) => c.conversaoBps !== null)
    .sort((x, y) => (y.conversaoBps ?? 0) - (x.conversaoBps ?? 0));
  const melhor = comBase[0];
  const pior = comBase[comBase.length - 1];
  if (comBase.length >= 2 && melhor && pior) {
    out.push({
      tom: 'info',
      texto: `Melhor campanha: "${melhor.nome}" com ${pctDeBps(melhor.conversaoBps)} (meta ${pctDeBps(melhor.metaBps)}); pior: "${pior.nome}" com ${pctDeBps(pior.conversaoBps)}.`,
    });
  }

  const abaixo = comBase.filter((c) => (c.conversaoBps ?? 0) < c.metaBps);
  if (abaixo.length > 0) {
    const nomes = abaixo
      .slice(0, 3)
      .map((c) => `"${c.nome}"`)
      .join(', ');
    out.push({
      tom: 'warn',
      texto: `${abaixo.length} de ${comBase.length} campanha(s) abaixo da meta: ${nomes}${abaixo.length > 3 ? '…' : ''}.`,
    });
  } else if (comBase.length > 0) {
    out.push({
      tom: 'ok',
      texto: `Todas as ${comBase.length} campanha(s) com entrega bateram a meta.`,
    });
  }

  const modelos = porModelo(rel.campanhas, rel.filtros.metaGlobalBps).filter(
    (m) => m.conversaoBps !== null,
  );
  const m0 = modelos[0];
  const mN = modelos[modelos.length - 1];
  if (modelos.length >= 2 && m0 && mN) {
    out.push({
      tom: 'info',
      texto: `Modelo com maior conversão: ${m0.chave} (${pctDeBps(m0.conversaoBps)}) contra ${mN.chave} (${pctDeBps(mN.conversaoBps)}).`,
    });
  }

  if (t.enviadas > 0 && t.falhas > 0) {
    const taxa = t.falhas / t.enviadas;
    out.push({
      tom: taxa >= 0.05 ? 'risk' : 'info',
      texto: `${porcentagem(t.falhas, t.enviadas)} dos envios falharam (${t.falhas} número(s)): ${taxa >= 0.05 ? 'vale revisar a carteira antes da próxima campanha' : 'dentro do esperado'}.`,
    });
  }

  if (t.entregues > 0) {
    out.push({
      tom: 'info',
      texto: `${porcentagem(t.responderam, t.entregues)} dos entregues responderam e ${porcentagem(t.cobrancas, t.entregues)} geraram cobrança.`,
    });
  }

  if (t.medianaHorasPagamento !== null) {
    const curta = t.medianaHorasPagamento > rel.filtros.janelaDias * 24 * 0.8;
    out.push({
      tom: curta ? 'warn' : 'info',
      texto: `Quem paga, paga em mediana ${horasLegiveis(t.medianaHorasPagamento)} depois do envio: a janela de ${rel.filtros.janelaDias} dias ${curta ? 'pode estar curta' : 'cobre o comportamento'}.`,
    });
  }

  if (t.pagas > 0) {
    out.push({
      tom: 'ok',
      texto: `${reaisDeCentavos(t.valorRecuperadoCentavos)} recuperados em ${t.pagas} pagamento(s); ticket médio ${reaisDeCentavos(Math.round(t.valorRecuperadoCentavos / t.pagas))}.`,
    });
  }

  if (t.escaladas > 0) {
    out.push({
      tom: 'warn',
      texto: `${t.escaladas} conversa(s) de campanha precisaram de gente (${porcentagem(t.escaladas, t.entregues)} dos entregues).`,
    });
  }
  return out;
}

const reaisCsv = (centavos: number) => (centavos / 100).toFixed(2).replace('.', ',');
const pctCsv = (bps: number | null) =>
  bps === null ? '' : (bps / 100).toFixed(2).replace('.', ',');

/** CSV do relatório: uma linha por campanha e a linha de totais no fim. */
export function csvRelatorio(rel: RelatorioCampanhas): string {
  const cab = [
    'campanha',
    'modelo',
    'envio',
    'competencia',
    'status',
    'destinatarios',
    'enviadas',
    'entregues',
    'lidas',
    'falhas',
    'responderam',
    'cobrancas',
    'pagas',
    'valor_recuperado',
    'conversao_pct',
    'meta_pct',
    'situacao',
    'escaladas',
    'mediana_horas_pagamento',
  ];
  const linha = (c: LinhaRelatorioCampanha) => [
    c.nome,
    c.modelo,
    c.criadoEm,
    c.competencia,
    c.status,
    c.destinatarios,
    c.enviadas,
    c.entregues,
    c.lidas,
    c.falhas,
    c.responderam,
    c.cobrancas,
    c.pagas,
    reaisCsv(c.valorRecuperadoCentavos),
    pctCsv(c.conversaoBps),
    pctCsv(c.metaBps),
    SITUACAO_META[situacaoMeta(c.conversaoBps, c.metaBps)].rotulo,
    c.escaladas,
    c.medianaHorasPagamento ?? '',
  ];
  const t = rel.totais;
  const total = [
    `TOTAL (${t.campanhas} campanhas · ${diaLegivel(rel.filtros.de)} a ${diaLegivel(rel.filtros.ate)} · janela ${rel.filtros.janelaDias} dias)`,
    '',
    '',
    rel.filtros.competencia ?? '',
    '',
    t.destinatarios,
    t.enviadas,
    t.entregues,
    t.lidas,
    t.falhas,
    t.responderam,
    t.cobrancas,
    t.pagas,
    reaisCsv(t.valorRecuperadoCentavos),
    pctCsv(t.conversaoBps),
    pctCsv(t.metaBps),
    SITUACAO_META[situacaoMeta(t.conversaoBps, t.metaBps)].rotulo,
    t.escaladas,
    t.medianaHorasPagamento ?? '',
  ];
  return paraCsv([cab, ...rel.campanhas.map(linha), total]);
}
