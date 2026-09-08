import { describe, expect, it } from 'vitest';
import type { LinhaRelatorioCampanha, RelatorioCampanhas } from '../lib/console-api';
import {
  agruparPor,
  competenciaLegivel,
  csvRelatorio,
  diaLegivel,
  horasLegiveis,
  insights,
  limitesDaCompetencia,
  pctDeBps,
  porCompetencia,
  porModelo,
  ppDeBps,
  situacaoMeta,
  somarDias,
} from '../lib/relatorio';

function linha(p: Partial<LinhaRelatorioCampanha> & { id: string }): LinhaRelatorioCampanha {
  const entregues = p.entregues ?? 0;
  const pagas = p.pagas ?? 0;
  return {
    nome: p.id,
    modelo: 'lembrete_v1',
    status: 'concluido',
    criadoEm: '2026-09-12T12:00:00.000Z',
    competencia: '2026-09',
    metaBps: 3000,
    destinatarios: entregues,
    enviadas: entregues,
    entregues,
    lidas: entregues,
    falhas: 0,
    responderam: 0,
    cobrancas: 0,
    pagas,
    valorRecuperadoCentavos: pagas * 125_000,
    escaladas: 0,
    medianaHorasPagamento: null,
    conversaoBps: entregues > 0 ? Math.round((pagas * 10_000) / entregues) : null,
    ...p,
  };
}

function relatorio(campanhas: LinhaRelatorioCampanha[], extra?: Partial<RelatorioCampanhas>) {
  const soma = (f: (c: LinhaRelatorioCampanha) => number) =>
    campanhas.reduce((s, c) => s + f(c), 0);
  const entregues = soma((c) => c.entregues);
  const pagas = soma((c) => c.pagas);
  const totais = {
    campanhas: campanhas.length,
    destinatarios: soma((c) => c.destinatarios),
    enviadas: soma((c) => c.enviadas),
    entregues,
    lidas: soma((c) => c.lidas),
    falhas: soma((c) => c.falhas),
    responderam: soma((c) => c.responderam),
    cobrancas: soma((c) => c.cobrancas),
    pagas,
    valorRecuperadoCentavos: soma((c) => c.valorRecuperadoCentavos),
    escaladas: soma((c) => c.escaladas),
    medianaHorasPagamento: null,
    conversaoBps: entregues > 0 ? Math.round((pagas * 10_000) / entregues) : null,
    metaBps: 3000,
  };
  const vazio = { ...totais, campanhas: 0, entregues: 0, pagas: 0, conversaoBps: null };
  const rel: RelatorioCampanhas = {
    filtros: {
      de: '2026-09-01',
      ate: '2026-09-30',
      competencia: null,
      modelo: null,
      janelaDias: 30,
      metaGlobalBps: 3000,
    },
    campanhas,
    totais,
    anterior: { de: '2026-08-02', ate: '2026-08-31', totais: vazio },
    opcoes: { competencias: ['2026-09'], modelos: ['lembrete_v1'] },
    ...extra,
  };
  return rel;
}

describe('formatação', () => {
  it('bps vira percentual com vírgula; null vira travessão', () => {
    expect(pctDeBps(3000)).toBe('30,0%');
    expect(pctDeBps(1234, 2)).toBe('12,34%');
    expect(pctDeBps(null)).toBe('—');
    expect(ppDeBps(250)).toBe('+2,5 p.p.');
    expect(ppDeBps(-1000)).toBe('−10,0 p.p.');
    expect(ppDeBps(0)).toBe('0,0 p.p.');
  });

  it('datas e competências não passam por Date (sem deslocar o dia pelo fuso)', () => {
    expect(diaLegivel('2026-09-08')).toBe('08/09/2026');
    expect(competenciaLegivel('2026-09')).toBe('set/26');
    expect(somarDias('2026-03-01', -1)).toBe('2026-02-28');
    expect(somarDias('2024-02-28', 1)).toBe('2024-02-29');
    expect(limitesDaCompetencia('2026-02')).toEqual({ de: '2026-02-01', ate: '2026-02-28' });
    expect(limitesDaCompetencia('2026-12')).toEqual({ de: '2026-12-01', ate: '2026-12-31' });
  });

  it('horas legíveis', () => {
    expect(horasLegiveis(null)).toBe('—');
    expect(horasLegiveis(0.4)).toBe('menos de 1 h');
    expect(horasLegiveis(5.6)).toBe('6 h');
    expect(horasLegiveis(72)).toBe('3,0 dias');
  });
});

describe('meta e agrupamentos', () => {
  it('situação contra a meta: acima, abaixo ou sem base', () => {
    expect(situacaoMeta(3000, 3000)).toBe('acima');
    expect(situacaoMeta(2999, 3000)).toBe('abaixo');
    expect(situacaoMeta(null, 3000)).toBe('sem_dados');
  });

  it('agrupa somando e pondera a meta pelas entregas', () => {
    const campanhas = [
      linha({ id: 'a', entregues: 100, pagas: 40, metaBps: 3000 }),
      linha({ id: 'b', entregues: 300, pagas: 30, metaBps: 1000 }),
      linha({ id: 'c', modelo: 'suave_v1', entregues: 0, pagas: 0 }),
    ];
    const porM = porModelo(campanhas, 3000);
    expect(porM.map((m) => m.chave)).toEqual(['lembrete_v1', 'suave_v1']);
    expect(porM[0]).toMatchObject({
      campanhas: 2,
      entregues: 400,
      pagas: 70,
      conversaoBps: 1750,
      metaBps: 1500, // (3000×100 + 1000×300) / 400
    });
    expect(porM[1]).toMatchObject({ conversaoBps: null, metaBps: 3000 }); // sem entrega ⇒ global
    const porC = porCompetencia(
      [...campanhas, linha({ id: 'd', competencia: '2026-08', entregues: 10, pagas: 1 })],
      3000,
    );
    expect(porC.map((c) => c.chave)).toEqual(['2026-08', '2026-09']);
    expect(agruparPor([], (c) => c.modelo, 3000)).toEqual([]);
  });
});

describe('insights', () => {
  it('sem campanha, um aviso só', () => {
    expect(insights(relatorio([]))).toEqual([
      { tom: 'off', texto: 'Nenhuma campanha no período com esses filtros.' },
    ]);
  });

  it('lê conversão × meta, período anterior, melhor/pior, falhas, tempo e ticket', () => {
    const rel = relatorio(
      [
        linha({ id: 'Boa', entregues: 100, pagas: 50, responderam: 60, cobrancas: 55 }),
        linha({
          id: 'Fraca',
          modelo: 'suave_v1',
          entregues: 100,
          pagas: 10,
          falhas: 20,
          enviadas: 120,
          escaladas: 3,
        }),
      ],
      {
        anterior: {
          de: '2026-08-02',
          ate: '2026-08-31',
          totais: {
            ...relatorio([]).totais,
            campanhas: 1,
            entregues: 50,
            pagas: 10,
            conversaoBps: 2000,
          },
        },
      },
    );
    rel.totais.medianaHorasPagamento = 30;
    const textos = insights(rel).map((i) => i.texto);
    expect(textos[0]).toBe('Conversão de 30,0% contra meta de 30,0%: 0,0 p.p. acima da meta.');
    expect(textos[1]).toBe(
      '+10,0 p.p. em relação ao período anterior (02/08/2026 a 31/08/2026: 20,0%).',
    );
    expect(textos).toContain(
      'Melhor campanha: "Boa" com 50,0% (meta 30,0%); pior: "Fraca" com 10,0%.',
    );
    expect(textos).toContain('1 de 2 campanha(s) abaixo da meta: "Fraca".');
    expect(textos).toContain(
      'Modelo com maior conversão: lembrete_v1 (50,0%) contra suave_v1 (10,0%).',
    );
    expect(textos.some((t) => t.startsWith('9% dos envios falharam (20 número(s))'))).toBe(true);
    expect(textos).toContain('30% dos entregues responderam e 28% geraram cobrança.');
    expect(textos).toContain(
      'Quem paga, paga em mediana 30 h depois do envio: a janela de 30 dias cobre o comportamento.',
    );
    expect(textos).toContain(
      'R$ 75.000,00 recuperados em 60 pagamento(s); ticket médio R$ 1.250,00.',
    );
    expect(textos).toContain('3 conversa(s) de campanha precisaram de gente (2% dos entregues).');
    const tons = insights(rel).map((i) => i.tom);
    expect(tons[0]).toBe('ok');
    expect(tons).toContain('warn');
  });

  it('abaixo da meta e sem período anterior', () => {
    const rel = relatorio([linha({ id: 'Única', entregues: 10, pagas: 1 })]);
    const lista = insights(rel);
    expect(lista[0]).toEqual({
      tom: 'risk',
      texto: 'Conversão de 10,0% contra meta de 30,0%: 20,0 p.p. abaixo da meta.',
    });
    expect(lista[1]).toEqual({
      tom: 'off',
      texto: 'Sem campanhas no período anterior para comparar.',
    });
    expect(lista.map((i) => i.texto)).toContain('1 de 1 campanha(s) abaixo da meta: "Única".');
  });
});

describe('csv', () => {
  it('uma linha por campanha e o total no fim, com ; e vírgula decimal', () => {
    const rel = relatorio([
      linha({ id: 'Lembrete', entregues: 4, pagas: 1, medianaHorasPagamento: 12.5 }),
    ]);
    const linhas = csvRelatorio(rel).split('\n');
    expect(linhas).toHaveLength(3);
    expect(linhas[0]?.startsWith('campanha;modelo;envio;competencia;status;')).toBe(true);
    expect(linhas[1]).toBe(
      'Lembrete;lembrete_v1;2026-09-12T12:00:00.000Z;2026-09;concluido;4;4;4;4;0;0;0;1;1250,00;25,00;30,00;Abaixo da meta;0;12.5',
    );
    expect(
      linhas[2]?.startsWith('TOTAL (1 campanhas · 01/09/2026 a 30/09/2026 · janela 30 dias);'),
    ).toBe(true);
    expect(linhas[2]?.endsWith(';1;1250,00;25,00;30,00;Abaixo da meta;0;')).toBe(true);
  });
});
