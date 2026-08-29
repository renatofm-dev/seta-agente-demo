'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api, type Metricas } from '@/lib/console-api';
import { cn } from '@/lib/utils';

/**
 * /metricas (010): conversas/dia, taxa de resolução sem humano, escalonamentos
 * por motivo, tokens + custo estimado/dia e p95 de latência. Janela 7/30 dias.
 */

function Card({ titulo, valor, nota }: { titulo: string; valor: string; nota?: string }) {
  return (
    <div className="rounded-lg border p-4">
      <p className="text-xs text-muted-foreground">{titulo}</p>
      <p className="mt-1 text-2xl font-semibold">{valor}</p>
      {nota && <p className="mt-1 text-[11px] text-muted-foreground">{nota}</p>}
    </div>
  );
}

const fmtMs = (v: number | null) => (v === null ? '—' : `${Math.round(v)} ms`);
const fmtPct = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(0)}%`);

export default function MetricasPage() {
  const [dias, setDias] = useState<7 | 30>(7);
  const [m, setM] = useState<Metricas | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  const carregar = useCallback(() => {
    api
      .metricas(dias)
      .then(setM)
      .catch((e) => setErro(e instanceof Error ? e.message : String(e)));
  }, [dias]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  if (erro) return <main className="p-6 text-sm text-red-600">{erro}</main>;
  if (!m) return <main className="p-6 text-sm">Carregando métricas…</main>;

  return (
    <main className="space-y-6 overflow-y-auto p-6">
      <header className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">Métricas</h1>
        <div className="flex rounded-md border text-xs">
          {([7, 30] as const).map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDias(d)}
              className={cn('px-3 py-1', dias === d && 'bg-muted font-medium')}
            >
              {d} dias
            </button>
          ))}
        </div>
        <button type="button" onClick={carregar} className="rounded-md border px-3 py-1 text-xs">
          Atualizar
        </button>
      </header>

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Card titulo="Conversas no período" valor={String(m.totalConversas)} />
        <Card
          titulo="Resolução sem humano"
          valor={fmtPct(m.taxaResolucaoSemHumano)}
          nota={`${m.totalEscaladas} conversa(s) escalada(s)`}
        />
        <Card titulo="p95 turno" valor={fmtMs(m.p95TurnoMs)} />
        <Card titulo="p95 query ERP" valor={fmtMs(m.p95QueryMs)} />
        <Card
          titulo="Custo estimado"
          valor={m.custoTotal.toFixed(4)}
          nota="preço por 1M tokens no env"
        />
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-lg border p-4">
          <h2 className="mb-2 text-sm font-medium">Conversas por dia</h2>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={m.conversasPorDia}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="dia" fontSize={11} />
              <YAxis allowDecimals={false} fontSize={11} />
              <Tooltip />
              <Bar dataKey="conversas" fill="var(--color-primary, #2563eb)" name="conversas" />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="rounded-lg border p-4">
          <h2 className="mb-2 text-sm font-medium">Tokens por dia (entrada × saída)</h2>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={m.tokensPorDia}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="dia" fontSize={11} />
              <YAxis fontSize={11} />
              <Tooltip />
              <Legend />
              <Line type="monotone" dataKey="entrada" stroke="#2563eb" name="entrada" />
              <Line type="monotone" dataKey="saida" stroke="#16a34a" name="saída" />
            </LineChart>
          </ResponsiveContainer>
        </div>

        <div className="rounded-lg border p-4">
          <h2 className="mb-2 text-sm font-medium">Escalonamentos por motivo</h2>
          {m.escalonamentosPorMotivo.length === 0 ? (
            <p className="text-xs text-muted-foreground">Nenhum escalonamento no período.</p>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={m.escalonamentosPorMotivo} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis type="number" allowDecimals={false} fontSize={11} />
                <YAxis type="category" dataKey="motivo" width={140} fontSize={11} />
                <Tooltip />
                <Bar dataKey="total" fill="#d97706" name="escalonamentos" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="rounded-lg border p-4">
          <h2 className="mb-2 text-sm font-medium">Custo estimado por dia</h2>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={m.tokensPorDia}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="dia" fontSize={11} />
              <YAxis fontSize={11} />
              <Tooltip />
              <Bar dataKey="custo" fill="#7c3aed" name="custo" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>
    </main>
  );
}
