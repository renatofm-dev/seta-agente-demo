'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Button } from '@/components/ui/button';
import { Barra, Card, Kpi, Vazio } from '@/components/ui/card';
import { Chip, Eyebrow } from '@/components/ui/chip';
import { Funil } from '@/components/ui/funil';
import { Campo, Input, Select } from '@/components/ui/input';
import { PageHeader, Pagina } from '@/components/ui/page-header';
import { Linha, Tabela } from '@/components/ui/tabela';
import {
  api,
  JANELAS_ATRIBUICAO,
  type JanelaAtribuicao,
  type RelatorioCampanhas,
} from '@/lib/console-api';
import { dataHoraCurta, porcentagem, reaisDeCentavos } from '@/lib/formatos';
import {
  competenciaLegivel,
  csvRelatorio,
  diaLegivel,
  hojeLocal,
  horasLegiveis,
  insights,
  limitesDaCompetencia,
  pctDeBps,
  porCompetencia,
  porModelo,
  ppDeBps,
  SITUACAO_META,
  situacaoMeta,
  somarDias,
} from '@/lib/relatorio';
import { cn } from '@/lib/utils';
import { useInstalacao } from '../layout';

/**
 * Métricas › Relatório de campanhas (017): funil completo (enviadas → pagas),
 * conversão × meta, comparação com o período anterior, por modelo e por
 * competência, insights em prosa e export (CSV e impressão/PDF). Os filtros
 * vivem na URL para o link ser compartilhável.
 */

const COLUNAS = '2fr 1.1fr .8fr .75fr .9fr .85fr .7fr .8fr .7fr 1.1fr';
const PRESETS = [7, 30, 90] as const;

interface Filtros {
  de: string;
  ate: string;
  competencia: string;
  modelo: string;
  janelaDias: JanelaAtribuicao;
}

function filtrosDaUrl(params: URLSearchParams): Filtros {
  const hoje = hojeLocal();
  const janela = Number(params.get('janela'));
  return {
    de: params.get('de') ?? somarDias(hoje, -29),
    ate: params.get('ate') ?? hoje,
    competencia: params.get('competencia') ?? '',
    modelo: params.get('modelo') ?? '',
    janelaDias: (JANELAS_ATRIBUICAO as readonly number[]).includes(janela)
      ? (janela as JanelaAtribuicao)
      : 30,
  };
}

function urlDe(f: Filtros): string {
  const p = new URLSearchParams({ v: 'campanhas', de: f.de, ate: f.ate });
  if (f.competencia) p.set('competencia', f.competencia);
  if (f.modelo) p.set('modelo', f.modelo);
  if (f.janelaDias !== 30) p.set('janela', String(f.janelaDias));
  return `/metricas?${p}`;
}

function Toggle<T extends string | number>({
  opcoes,
  valor,
  aoMudar,
}: {
  opcoes: readonly { id: T; rotulo: string }[];
  valor: T;
  aoMudar: (v: T) => void;
}) {
  return (
    <div className="flex gap-0.5 rounded-[10px] border border-line bg-surface p-[3px]">
      {opcoes.map((o) => (
        <button
          key={String(o.id)}
          type="button"
          onClick={() => aoMudar(o.id)}
          className={cn(
            'h-[30px] rounded-[7px] px-3 text-[12.5px] font-semibold',
            valor === o.id ? 'bg-ink text-white' : 'text-text-2 hover:text-ink',
          )}
        >
          {o.rotulo}
        </button>
      ))}
    </div>
  );
}

export function RelatorioCampanhasView() {
  const router = useRouter();
  const params = useSearchParams();
  const instalacao = useInstalacao();
  const filtros = useMemo(() => filtrosDaUrl(params), [params]);
  const [rel, setRel] = useState<RelatorioCampanhas | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);

  useEffect(() => {
    let vivo = true;
    setCarregando(true);
    api
      .relatorioCampanhas({
        de: filtros.de,
        ate: filtros.ate,
        competencia: filtros.competencia || undefined,
        modelo: filtros.modelo || undefined,
        janelaDias: filtros.janelaDias,
      })
      .then((r) => {
        if (!vivo) return;
        setRel(r);
        setErro(null);
      })
      .catch((e) => vivo && setErro(e instanceof Error ? e.message : String(e)))
      .finally(() => vivo && setCarregando(false));
    return () => {
      vivo = false;
    };
  }, [filtros]);

  const aplicar = (parte: Partial<Filtros>) => router.replace(urlDe({ ...filtros, ...parte }));

  const presetAtivo = PRESETS.find(
    (n) => filtros.ate === hojeLocal() && filtros.de === somarDias(filtros.ate, -(n - 1)),
  );

  const t = rel?.totais;
  const metaGlobal = rel?.filtros.metaGlobalBps ?? instalacao?.campanhas.metaConversaoBps ?? 0;
  const modelos = useMemo(
    () => (rel ? porModelo(rel.campanhas, metaGlobal) : []),
    [rel, metaGlobal],
  );
  const competencias = useMemo(
    () => (rel ? porCompetencia(rel.campanhas, metaGlobal) : []),
    [rel, metaGlobal],
  );
  const lista = useMemo(() => (rel ? insights(rel) : []), [rel]);
  const situacao = t ? situacaoMeta(t.conversaoBps, t.metaBps) : 'sem_dados';
  const deltaAnterior =
    t && t.conversaoBps !== null && rel && rel.anterior.totais.conversaoBps !== null
      ? t.conversaoBps - rel.anterior.totais.conversaoBps
      : null;

  function exportarCsv() {
    if (!rel) return;
    const blob = new Blob([`﻿${csvRelatorio(rel)}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `relatorio-campanhas-${rel.filtros.de}-${rel.filtros.ate}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const opcoesModelo = [...new Set([...(rel?.opcoes.modelos ?? []), filtros.modelo])].filter(
    Boolean,
  );
  const opcoesCompetencia = [
    ...new Set([...(rel?.opcoes.competencias ?? []), filtros.competencia]),
  ].filter(Boolean);

  return (
    <Pagina>
      <PageHeader
        eyebrow={instalacao?.nome ?? 'Métricas'}
        titulo="Relatório de campanhas"
        subtitulo={
          rel
            ? `${diaLegivel(rel.filtros.de)} a ${diaLegivel(rel.filtros.ate)} · janela de atribuição ${rel.filtros.janelaDias} dias · meta ${pctDeBps(rel.filtros.metaGlobalBps, 0)}${rel.filtros.modelo ? ` · modelo ${rel.filtros.modelo}` : ''}`
            : undefined
        }
        acoes={
          <div className="flex gap-2 print:hidden">
            <Button variant="outline" size="md" onClick={exportarCsv} disabled={!rel}>
              Exportar CSV
            </Button>
            <Button variant="ink" size="md" onClick={() => window.print()} disabled={!rel}>
              Imprimir / PDF
            </Button>
          </div>
        }
      />

      <Card className="flex flex-wrap items-end gap-3 p-4 print:hidden">
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold text-text-2">Período</span>
          <div className="flex flex-wrap items-center gap-2">
            <Toggle
              opcoes={PRESETS.map((n) => ({ id: n, rotulo: `${n} dias` }))}
              valor={presetAtivo ?? 0}
              aoMudar={(n) => {
                const hoje = hojeLocal();
                aplicar({ de: somarDias(hoje, -(n - 1)), ate: hoje, competencia: '' });
              }}
            />
            <Input
              compacto
              type="date"
              value={filtros.de}
              max={filtros.ate}
              onChange={(e) => e.target.value && aplicar({ de: e.target.value, competencia: '' })}
              className="w-[150px]"
              aria-label="De"
            />
            <span className="text-xs text-text-3">a</span>
            <Input
              compacto
              type="date"
              value={filtros.ate}
              min={filtros.de}
              onChange={(e) => e.target.value && aplicar({ ate: e.target.value, competencia: '' })}
              className="w-[150px]"
              aria-label="Até"
            />
          </div>
        </div>
        <Campo rotulo="Competência">
          <Select
            compacto
            value={filtros.competencia}
            onChange={(e) => {
              const c = e.target.value;
              if (!c) aplicar({ competencia: '' });
              else aplicar({ competencia: c, ...limitesDaCompetencia(c) });
            }}
            className="w-[150px]"
          >
            <option value="">Todas</option>
            {opcoesCompetencia.map((c) => (
              <option key={c} value={c}>
                {competenciaLegivel(c)}
              </option>
            ))}
          </Select>
        </Campo>
        <Campo rotulo="Modelo">
          <Select
            compacto
            value={filtros.modelo}
            onChange={(e) => aplicar({ modelo: e.target.value })}
            className="w-[190px] font-mono text-[12.5px]"
          >
            <option value="">Todos</option>
            {opcoesModelo.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </Select>
        </Campo>
        <div className="flex flex-col gap-1.5">
          <span
            className="text-xs font-semibold text-text-2"
            title="Quantos dias depois do envio um pagamento ainda conta para a campanha"
          >
            Janela de atribuição
          </span>
          <Toggle
            opcoes={JANELAS_ATRIBUICAO.map((n) => ({ id: n, rotulo: `${n} d` }))}
            valor={filtros.janelaDias}
            aoMudar={(n) => aplicar({ janelaDias: n })}
          />
        </div>
      </Card>

      {erro && <p className="m-0 text-xs text-brand">{erro}</p>}
      {carregando && !rel && <p className="m-0 text-sm text-text-3">Carregando relatório…</p>}

      {rel && t && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi
              rotulo="Conversão (pagas ÷ entregues)"
              valor={pctDeBps(t.conversaoBps)}
              tom={situacao === 'acima' ? 'ok' : situacao === 'abaixo' ? 'risk' : undefined}
              atencao={situacao === 'abaixo'}
              nota={
                <>
                  meta {pctDeBps(t.metaBps)}
                  {deltaAnterior !== null && (
                    <>
                      {' · '}
                      <span className={deltaAnterior >= 0 ? 'text-ok' : 'text-brand'}>
                        {ppDeBps(deltaAnterior)}
                      </span>{' '}
                      vs. anterior
                    </>
                  )}
                </>
              }
            />
            <Kpi
              rotulo="Valor recuperado"
              valor={reaisDeCentavos(t.valorRecuperadoCentavos)}
              tom={t.pagas > 0 ? 'ok' : undefined}
              nota={
                t.pagas > 0
                  ? `${t.pagas} pagamento(s) · ticket médio ${reaisDeCentavos(Math.round(t.valorRecuperadoCentavos / t.pagas))}`
                  : 'nenhum pagamento atribuído'
              }
            />
            <Kpi
              rotulo="Entregues"
              valor={t.entregues}
              nota={`de ${t.enviadas} enviadas · ${t.falhas} falha(s) · ${t.campanhas} campanha(s)`}
            />
            <Kpi
              rotulo="Responderam"
              valor={t.responderam}
              nota={`${porcentagem(t.responderam, t.entregues)} dos entregues · ${t.cobrancas} cobrança(s) gerada(s)`}
            />
          </div>

          {t.campanhas === 0 ? (
            <Vazio
              titulo="Nenhuma campanha neste recorte"
              texto="Amplie o período ou limpe os filtros de competência e modelo. As campanhas nascem em Campanhas › Nova campanha."
              acao={
                <Link href="/campanhas" className="text-[13px] font-semibold">
                  Ir para campanhas →
                </Link>
              }
            />
          ) : (
            <>
              <Card className="p-5">
                <div className="mb-3.5 flex flex-wrap items-baseline justify-between gap-2">
                  <Eyebrow>Funil do período</Eyebrow>
                  <span className="text-xs text-text-3">
                    eventos até {rel.filtros.janelaDias} dias após o envio; a última campanha que
                    alcançou o número leva o crédito
                  </span>
                </div>
                <Funil
                  base={t.enviadas}
                  etapas={[
                    { rotulo: 'Enviadas', n: t.enviadas, cor: 'bg-line-strong' },
                    { rotulo: 'Entregues', n: t.entregues, cor: 'bg-brand' },
                    { rotulo: 'Lidas', n: t.lidas, cor: 'bg-brand' },
                    { rotulo: 'Responderam', n: t.responderam, cor: 'bg-laranja' },
                    { rotulo: 'Cobranças', n: t.cobrancas, cor: 'bg-info-2' },
                    { rotulo: 'Pagas', n: t.pagas, cor: 'bg-ok' },
                  ]}
                />
              </Card>

              <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
                <Card className="flex flex-col gap-3.5 p-5">
                  <div className="flex items-baseline justify-between">
                    <div className="font-semibold">Conversão por competência</div>
                    <div className="flex items-center gap-1.5 text-xs text-text-2">
                      <span className="size-2.5 rounded-[3px] bg-brand" /> conversão ·{' '}
                      <span className="inline-block h-0 w-4 border-t-2 border-dashed border-ink" />{' '}
                      meta
                    </div>
                  </div>
                  <ResponsiveContainer width="100%" height={200}>
                    <BarChart
                      data={competencias.map((c) => ({
                        competencia: competenciaLegivel(c.chave),
                        conversao: c.conversaoBps === null ? 0 : c.conversaoBps / 100,
                        pagas: c.pagas,
                        entregues: c.entregues,
                      }))}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" vertical={false} />
                      <XAxis
                        dataKey="competencia"
                        fontSize={10}
                        stroke="var(--text-3)"
                        tickLine={false}
                        axisLine={false}
                      />
                      <YAxis
                        fontSize={10}
                        stroke="var(--text-3)"
                        tickLine={false}
                        axisLine={false}
                        width={34}
                        unit="%"
                      />
                      <Tooltip
                        cursor={{ fill: 'var(--surface-3)' }}
                        formatter={(v, nome) => [
                          nome === 'conversão' ? `${Number(v).toFixed(1).replace('.', ',')}%` : v,
                          nome,
                        ]}
                        contentStyle={{
                          borderRadius: 10,
                          border: '1px solid var(--line)',
                          fontSize: 12,
                        }}
                      />
                      <ReferenceLine
                        y={t.metaBps / 100}
                        stroke="var(--ink)"
                        strokeDasharray="4 4"
                        label={{
                          value: `meta ${pctDeBps(t.metaBps, 0)}`,
                          position: 'insideTopRight',
                          fontSize: 10,
                          fill: 'var(--text-2)',
                        }}
                      />
                      <Bar
                        dataKey="conversao"
                        fill="var(--brand)"
                        radius={[3, 3, 0, 0]}
                        name="conversão"
                      />
                    </BarChart>
                  </ResponsiveContainer>
                </Card>
                <Card className="flex flex-col gap-3 p-5">
                  <div className="font-semibold">Por modelo</div>
                  {modelos.map((m) => {
                    const s = situacaoMeta(m.conversaoBps, m.metaBps);
                    return (
                      <div key={m.chave} className="flex flex-col gap-1">
                        <div className="flex items-baseline justify-between gap-2 text-[12.5px]">
                          <span className="truncate font-mono text-[12px] text-text-2">
                            {m.chave}
                          </span>
                          <span
                            className={cn(
                              'shrink-0 font-heading font-semibold',
                              s === 'acima'
                                ? 'text-ok'
                                : s === 'abaixo'
                                  ? 'text-brand'
                                  : 'text-text-3',
                            )}
                          >
                            {pctDeBps(m.conversaoBps)}
                            <span className="ml-1 font-mono text-[10.5px] font-normal text-text-3">
                              {m.pagas}/{m.entregues} · {m.campanhas} camp.
                            </span>
                          </span>
                        </div>
                        <Barra
                          fracao={
                            m.conversaoBps === null
                              ? 0
                              : m.conversaoBps / Math.max(m.metaBps * 2, 1)
                          }
                          cor={s === 'acima' ? 'bg-ok' : 'bg-brand'}
                        />
                      </div>
                    );
                  })}
                </Card>
              </div>

              <Tabela
                colunas={COLUNAS}
                minWidth={1040}
                cabecalho={[
                  'Campanha',
                  'Envio',
                  'Competência',
                  'Entregues',
                  'Responderam',
                  'Cobranças',
                  'Pagas',
                  'Conversão',
                  'Meta',
                  'Situação',
                ]}
              >
                {rel.campanhas.map((c) => {
                  const s = situacaoMeta(c.conversaoBps, c.metaBps);
                  return (
                    <Linha
                      key={c.id}
                      colunas={COLUNAS}
                      onClick={() => router.push(`/campanhas/${c.id}`)}
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-semibold">{c.nome}</span>
                        <span className="block truncate font-mono text-[11px] text-text-3">
                          {c.modelo} · {c.destinatarios} contatos
                          {c.falhas > 0 ? ` · ${c.falhas} falha(s)` : ''}
                        </span>
                      </span>
                      <span className="font-mono text-[11.5px] text-text-2">
                        {dataHoraCurta(c.criadoEm)}
                      </span>
                      <span className="text-text-2">{competenciaLegivel(c.competencia)}</span>
                      <span>{c.entregues}</span>
                      <span>
                        {c.responderam}
                        <span className="ml-1 font-mono text-[10.5px] text-text-3">
                          {porcentagem(c.responderam, c.entregues)}
                        </span>
                      </span>
                      <span>{c.cobrancas}</span>
                      <span className={cn(c.pagas > 0 && 'font-semibold text-ok')}>{c.pagas}</span>
                      <span className="font-heading font-semibold">{pctDeBps(c.conversaoBps)}</span>
                      <span className="text-text-2">{pctDeBps(c.metaBps)}</span>
                      <span>
                        <Chip papel={SITUACAO_META[s].papel}>{SITUACAO_META[s].rotulo}</Chip>
                      </span>
                    </Linha>
                  );
                })}
                <div
                  className="grid items-center gap-3 bg-surface-2 px-4 py-2.5 text-[13px] font-semibold"
                  style={{ gridTemplateColumns: COLUNAS }}
                >
                  <span>Total · {t.campanhas} campanha(s)</span>
                  <span />
                  <span />
                  <span>{t.entregues}</span>
                  <span>{t.responderam}</span>
                  <span>{t.cobrancas}</span>
                  <span className="text-ok">{t.pagas}</span>
                  <span className="font-heading">{pctDeBps(t.conversaoBps)}</span>
                  <span className="text-text-2">{pctDeBps(t.metaBps)}</span>
                  <span>
                    <Chip papel={SITUACAO_META[situacao].papel}>
                      {SITUACAO_META[situacao].rotulo}
                    </Chip>
                  </span>
                </div>
              </Tabela>

              <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
                <Card className="flex flex-col gap-2.5 p-5">
                  <div className="font-semibold">Insights</div>
                  <ul className="m-0 flex list-none flex-col gap-2 p-0">
                    {lista.map((i) => (
                      <li
                        key={i.texto}
                        className="flex items-start gap-2.5 text-[13px] text-text-2"
                      >
                        <span
                          className={cn(
                            'mt-[7px] size-2 shrink-0 rounded-full',
                            {
                              ok: 'bg-ok',
                              warn: 'bg-warn-2',
                              risk: 'bg-brand',
                              info: 'bg-info-2',
                              off: 'bg-text-3',
                            }[i.tom],
                          )}
                        />
                        <span>{i.texto}</span>
                      </li>
                    ))}
                  </ul>
                </Card>
                <Card className="flex flex-col gap-1 p-5">
                  <div className="mb-1 font-semibold">Período anterior</div>
                  {[
                    {
                      rotulo: 'Intervalo',
                      valor: `${diaLegivel(rel.anterior.de)} a ${diaLegivel(rel.anterior.ate)}`,
                    },
                    { rotulo: 'Campanhas', valor: rel.anterior.totais.campanhas },
                    { rotulo: 'Entregues', valor: rel.anterior.totais.entregues },
                    { rotulo: 'Pagas', valor: rel.anterior.totais.pagas },
                    { rotulo: 'Conversão', valor: pctDeBps(rel.anterior.totais.conversaoBps) },
                    {
                      rotulo: 'Valor recuperado',
                      valor: reaisDeCentavos(rel.anterior.totais.valorRecuperadoCentavos),
                    },
                    {
                      rotulo: 'Mediana até pagar',
                      valor: horasLegiveis(rel.anterior.totais.medianaHorasPagamento),
                    },
                  ].map((i) => (
                    <div
                      key={i.rotulo}
                      className="grid grid-cols-[1fr_auto] items-center gap-2 border-t border-line-soft py-1.5 text-[12.5px]"
                    >
                      <span className="text-text-2">{i.rotulo}</span>
                      <span className="font-heading font-semibold">{i.valor}</span>
                    </div>
                  ))}
                  <p className="m-0 mt-2 text-[11.5px] text-text-3">
                    Mesma duração, imediatamente antes do período. O filtro de competência não se
                    aplica à comparação.
                  </p>
                </Card>
              </div>
            </>
          )}
        </>
      )}
    </Pagina>
  );
}
