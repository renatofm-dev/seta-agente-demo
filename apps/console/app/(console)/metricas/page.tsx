'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Barra, Card, Kpi } from '@/components/ui/card';
import { PageHeader, Pagina } from '@/components/ui/page-header';
import { funilDe } from '@/lib/campanhas';
import { api, type CobrancasResposta, type DisparoResumo, type Metricas } from '@/lib/console-api';
import { porcentagem, reaisDeCentavos } from '@/lib/formatos';
import { motivoLabel } from '@/lib/rotulos';
import { cn } from '@/lib/utils';
import { useInstalacao } from '../layout';
import { RelatorioCampanhasView } from './relatorio-campanhas';

/**
 * Métricas (010 + design 5.7): KPIs do período, conversas por dia, motivos de
 * escalada, funil de cobrança (014), atendimento humano e saúde do canal (013).
 * Valor recuperado e funil vêm das cobranças; entrega vem das campanhas.
 * A aba "Relatório de campanhas" (017, `?v=campanhas`) cruza campanhas com
 * resultado e meta de conversão.
 */

const CORES = ['bg-brand', 'bg-laranja', 'bg-info-2', 'bg-roxo', 'bg-text-3'];

function Bloco({
  titulo,
  itens,
}: {
  titulo: string;
  itens: { rotulo: string; valor: React.ReactNode; cor?: string }[];
}) {
  return (
    <Card className="flex flex-col gap-1 p-5">
      <div className="mb-1 font-semibold">{titulo}</div>
      {itens.map((i) => (
        <div
          key={i.rotulo}
          className="grid grid-cols-[1fr_auto] items-center gap-2 border-t border-line-soft py-1.5 text-[12.5px]"
        >
          <span className="text-text-2">{i.rotulo}</span>
          <span className={cn('font-heading font-semibold', i.cor)}>{i.valor}</span>
        </div>
      ))}
    </Card>
  );
}

const fmtMs = (v: number | null) => (v === null ? '—' : `${Math.round(v)} ms`);
const fmtPct = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(0)}%`);
const diaCurto = (dia: string) => `${dia.slice(8, 10)}/${dia.slice(5, 7)}`;

function VisaoGeral() {
  const instalacao = useInstalacao();
  const [dias, setDias] = useState<7 | 30>(7);
  const [m, setM] = useState<Metricas | null>(null);
  const [cob, setCob] = useState<CobrancasResposta | null>(null);
  const [disparos, setDisparos] = useState<DisparoResumo[]>([]);
  const [erro, setErro] = useState<string | null>(null);

  const carregar = useCallback(() => {
    api
      .metricas(dias)
      .then(setM)
      .catch((e) => setErro(e instanceof Error ? e.message : String(e)));
    api
      .cobrancas()
      .then(setCob)
      .catch(() => setCob(null));
    api
      .disparos()
      .then((r) => setDisparos(r.disparos))
      .catch(() => {});
  }, [dias]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  const desde = Date.now() - dias * 86_400_000;
  const cobrancas = (cob?.cobrancas ?? []).filter((c) => new Date(c.criadoEm).getTime() >= desde);
  const pagas = (cob?.cobrancas ?? []).filter(
    (c) => c.pagoEm && new Date(c.pagoEm).getTime() >= desde,
  );
  const recuperado = pagas.reduce((s, c) => s + c.valorCentavos, 0);
  const abertas = cobrancas.filter(
    (c) => c.status === 'emitida' || c.status === 'emitindo' || c.status === 'aguardando_aprovacao',
  );
  const falhas = cobrancas.filter((c) => c.status === 'falha' || c.status === 'recusada');
  const campanhas = disparos.filter((d) => new Date(d.criado_em).getTime() >= desde);
  const funilCamp = campanhas.reduce(
    (acc, d) => {
      const f = funilDe(d);
      return {
        enviadas: acc.enviadas + f.enviadas,
        entregues: acc.entregues + f.entregues,
        lidas: acc.lidas + f.lidas,
        falhas: acc.falhas + f.falhas,
      };
    },
    { enviadas: 0, entregues: 0, lidas: 0, falhas: 0 },
  );
  const maxMotivo = Math.max(1, ...(m?.escalonamentosPorMotivo.map((x) => x.total) ?? [1]));
  const tokens = (m?.tokensPorDia ?? []).reduce((s, d) => s + d.entrada + d.saida, 0);

  return (
    <Pagina>
      <PageHeader
        eyebrow={instalacao?.nome ?? 'Métricas'}
        titulo="Métricas"
        acoes={
          <div className="flex gap-0.5 rounded-[10px] border border-line bg-surface p-[3px]">
            {([7, 30] as const).map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDias(d)}
                className={cn(
                  'h-[30px] rounded-[7px] px-3 text-[12.5px] font-semibold',
                  dias === d ? 'bg-ink text-white' : 'text-text-2 hover:text-ink',
                )}
              >
                {d} dias
              </button>
            ))}
          </div>
        }
      />
      {erro && <p className="m-0 text-xs text-brand">{erro}</p>}
      {!m && !erro && <p className="m-0 text-sm text-text-3">Carregando métricas…</p>}
      {m && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi
              rotulo="Valor recuperado"
              valor={cob ? reaisDeCentavos(recuperado) : '—'}
              tom="ok"
              nota={
                cob
                  ? `${pagas.length} cobrança(s) paga(s) no período`
                  : 'módulo de pagamentos desligado'
              }
            />
            <Kpi
              rotulo="Resolvido pelo agente"
              valor={fmtPct(m.taxaResolucaoSemHumano)}
              nota={`${m.totalEscaladas} de ${m.totalConversas} conversas passaram por gente`}
            />
            <Kpi
              rotulo="Conversas no período"
              valor={m.totalConversas}
              nota={`p95 do turno ${fmtMs(m.p95TurnoMs)}`}
            />
            <Kpi
              rotulo="Custo estimado (LLM)"
              valor={m.custoTotal.toFixed(m.custoTotal < 1 ? 4 : 2)}
              nota={`${tokens.toLocaleString('pt-BR')} tokens · na unidade do preço por 1M do env`}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
            <Card className="flex flex-col gap-3.5 p-5">
              <div className="flex items-baseline justify-between">
                <div className="font-semibold">Conversas por dia</div>
                <div className="flex items-center gap-1.5 text-xs text-text-2">
                  <span className="size-2.5 rounded-[3px] bg-brand" /> conversas com turno do agente
                </div>
              </div>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={m.conversasPorDia.map((d) => ({ ...d, dia: diaCurto(d.dia) }))}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" vertical={false} />
                  <XAxis
                    dataKey="dia"
                    fontSize={10}
                    stroke="var(--text-3)"
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    allowDecimals={false}
                    fontSize={10}
                    stroke="var(--text-3)"
                    tickLine={false}
                    axisLine={false}
                    width={28}
                  />
                  <Tooltip
                    cursor={{ fill: 'var(--surface-3)' }}
                    contentStyle={{
                      borderRadius: 10,
                      border: '1px solid var(--line)',
                      fontSize: 12,
                    }}
                  />
                  <Bar
                    dataKey="conversas"
                    fill="var(--brand)"
                    radius={[3, 3, 0, 0]}
                    name="conversas"
                  />
                </BarChart>
              </ResponsiveContainer>
            </Card>
            <Card className="flex flex-col gap-3 p-5">
              <div className="font-semibold">Motivos de escalada</div>
              {m.escalonamentosPorMotivo.length === 0 && (
                <p className="m-0 text-xs text-text-3">Nenhum escalonamento no período.</p>
              )}
              {m.escalonamentosPorMotivo.map((x, i) => (
                <div key={x.motivo} className="flex flex-col gap-1">
                  <div className="flex justify-between text-[12.5px]">
                    <span className="text-text-2" title={x.motivo}>
                      {motivoLabel(x.motivo)}
                    </span>
                    <span className="font-mono text-[11px] text-text-3">{x.total}</span>
                  </div>
                  <Barra fracao={x.total / maxMotivo} cor={CORES[i % CORES.length]} />
                </div>
              ))}
            </Card>
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            <Bloco
              titulo="Funil de cobrança"
              itens={[
                { rotulo: 'Mensagens de campanha', valor: funilCamp.enviadas },
                { rotulo: 'Cobranças geradas', valor: cob ? cobrancas.length : '—' },
                { rotulo: 'Aguardando pagamento', valor: cob ? abertas.length : '—' },
                {
                  rotulo: 'Pagas',
                  valor: cob
                    ? `${pagas.length} · ${porcentagem(pagas.length, cobrancas.length)}`
                    : '—',
                  cor: 'text-ok',
                },
                {
                  rotulo: 'Falhas e recusas',
                  valor: cob ? falhas.length : '—',
                  cor: falhas.length > 0 ? 'text-brand' : '',
                },
                {
                  rotulo: 'Ticket médio',
                  valor:
                    pagas.length > 0 ? reaisDeCentavos(Math.round(recuperado / pagas.length)) : '—',
                },
              ]}
            />
            <Bloco
              titulo="Atendimento humano"
              itens={[
                { rotulo: 'Escaladas', valor: m.totalEscaladas },
                { rotulo: 'Resolvido sem humano', valor: fmtPct(m.taxaResolucaoSemHumano) },
                { rotulo: 'p95 do turno do agente', valor: fmtMs(m.p95TurnoMs) },
                { rotulo: 'p95 das consultas ao ERP', valor: fmtMs(m.p95QueryMs) },
              ]}
            />
            <Bloco
              titulo="Saúde do canal"
              itens={[
                {
                  rotulo: 'Entrega das campanhas',
                  valor: porcentagem(funilCamp.entregues, funilCamp.enviadas),
                  cor: 'text-ok',
                },
                { rotulo: 'Leitura', valor: porcentagem(funilCamp.lidas, funilCamp.entregues) },
                {
                  rotulo: 'Falhas de envio',
                  valor: funilCamp.falhas,
                  cor: funilCamp.falhas > 0 ? 'text-brand' : '',
                },
                {
                  rotulo: 'Custo por conversa',
                  valor: m.totalConversas > 0 ? (m.custoTotal / m.totalConversas).toFixed(4) : '—',
                },
              ]}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="flex flex-col gap-3 p-5">
              <div className="flex items-baseline justify-between">
                <div className="font-semibold">Tokens por dia</div>
                <div className="flex gap-3.5 text-xs text-text-2">
                  <span className="flex items-center gap-1.5">
                    <span className="size-2.5 rounded-[3px] bg-brand" />
                    entrada
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="size-2.5 rounded-[3px] bg-laranja" />
                    saída
                  </span>
                </div>
              </div>
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={m.tokensPorDia.map((d) => ({ ...d, dia: diaCurto(d.dia) }))}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" vertical={false} />
                  <XAxis
                    dataKey="dia"
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
                    width={44}
                  />
                  <Tooltip
                    contentStyle={{
                      borderRadius: 10,
                      border: '1px solid var(--line)',
                      fontSize: 12,
                    }}
                  />
                  <Line
                    type="monotone"
                    dataKey="entrada"
                    stroke="var(--brand)"
                    strokeWidth={2}
                    dot={false}
                    name="entrada"
                  />
                  <Line
                    type="monotone"
                    dataKey="saida"
                    stroke="var(--laranja)"
                    strokeWidth={2}
                    dot={false}
                    name="saída"
                  />
                </LineChart>
              </ResponsiveContainer>
            </Card>
            <Card className="flex flex-col gap-3 p-5">
              <div className="font-semibold">Custo estimado por dia</div>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={m.tokensPorDia.map((d) => ({ ...d, dia: diaCurto(d.dia) }))}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" vertical={false} />
                  <XAxis
                    dataKey="dia"
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
                    width={44}
                  />
                  <Tooltip
                    cursor={{ fill: 'var(--surface-3)' }}
                    contentStyle={{
                      borderRadius: 10,
                      border: '1px solid var(--line)',
                      fontSize: 12,
                    }}
                  />
                  <Bar dataKey="custo" fill="var(--roxo)" radius={[3, 3, 0, 0]} name="custo" />
                </BarChart>
              </ResponsiveContainer>
            </Card>
          </div>
        </>
      )}
    </Pagina>
  );
}

const ABAS = [
  { id: 'geral', rotulo: 'Visão geral', href: '/metricas' },
  { id: 'campanhas', rotulo: 'Relatório de campanhas', href: '/metricas?v=campanhas' },
] as const;

function MetricasConteudo() {
  const params = useSearchParams();
  const emCampanhas = params.get('v') === 'campanhas';
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 gap-1 border-b border-line bg-surface px-4 print:hidden">
        {ABAS.map((aba) => {
          const on = aba.id === 'campanhas' ? emCampanhas : !emCampanhas;
          return (
            <Link
              key={aba.id}
              href={aba.href}
              className={cn(
                'flex h-10 items-center border-b-2 px-2 text-xs font-semibold no-underline',
                on ? 'border-brand text-ink' : 'border-transparent text-text-3 hover:text-ink',
              )}
            >
              {aba.rotulo}
            </Link>
          );
        })}
      </div>
      <div className="min-h-0 flex-1">
        {emCampanhas ? <RelatorioCampanhasView /> : <VisaoGeral />}
      </div>
    </div>
  );
}

export default function MetricasPage() {
  return (
    <Suspense fallback={<main className="p-6 text-sm text-text-3">Carregando…</main>}>
      <MetricasConteudo />
    </Suspense>
  );
}
