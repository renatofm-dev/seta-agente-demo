'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, Vazio } from '@/components/ui/card';
import { Chip, Eyebrow } from '@/components/ui/chip';
import { Input, Textarea } from '@/components/ui/input';
import { Filtros } from '@/components/ui/tabela';
import {
  api,
  type ConversaDetalhe,
  type ConversaResumo,
  type FeedbackTurno,
  type TraceTurnoView,
} from '@/lib/console-api';
import { hora, horarioLista, nomeExibicao, telefoneBonito } from '@/lib/formatos';
import { MOTIVOS_FEEDBACK } from '@/lib/rotulos';
import { cn } from '@/lib/utils';
import { useSessao } from '../layout';
import { Curadoria } from './curadoria';
import { LinhaEvento } from './eventos';

/**
 * Aprendizado (design 5.6): explorador de turnos de uma conversa — o que o
 * agente viu, decidiu e respondeu, com tokens/latência — e o feedback do
 * atendente que vira sinal para o distiller. Curador vê também a Curadoria
 * (propostas + skills). Deep-link: ?c=<conversaId>&t=<traceId>.
 */

type FiltroTurno = 'todos' | 'escalados' | 'feedback' | 'tool' | 'fallback';

function passa(t: TraceTurnoView, f: FiltroTurno): boolean {
  if (f === 'todos') return true;
  if (f === 'escalados') return t.escalado;
  if (f === 'feedback') return t.feedback !== null;
  if (f === 'fallback') return t.fallback;
  return t.eventos.some((e) => e.tipo === 'tool');
}

function Feedback({
  trace,
  aoSalvo,
}: {
  trace: TraceTurnoView;
  aoSalvo: (traceId: string, fb: FeedbackTurno) => void;
}) {
  const [abertoRuim, setAbertoRuim] = useState(false);
  const [motivos, setMotivos] = useState<string[]>([]);
  const [sugestao, setSugestao] = useState('');
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reinicia o formulário ao trocar de turno
  useEffect(() => {
    setAbertoRuim(trace.feedback?.avaliacao === 'ruim');
    setMotivos(trace.feedback?.motivos ?? []);
    setSugestao(trace.feedback?.sugestao ?? '');
    setErro(null);
  }, [trace.id]);

  const atual = trace.feedback?.avaliacao ?? null;

  async function salvar(avaliacao: 'bom' | 'ruim') {
    setSalvando(true);
    setErro(null);
    try {
      const r = await api.feedbackTurno(trace.id, {
        avaliacao,
        ...(avaliacao === 'ruim' ? { motivos, sugestao: sugestao.trim() || undefined } : {}),
      });
      aoSalvo(trace.id, r.feedback);
      if (avaliacao === 'bom') setAbertoRuim(false);
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e));
    } finally {
      setSalvando(false);
    }
  }

  return (
    <Card className="flex flex-col gap-3 p-5">
      <Eyebrow>Feedback do atendente</Eyebrow>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={salvando}
          onClick={() => salvar('bom')}
          className={cn(
            'h-10 flex-1 rounded-[9px] border text-[13px] font-semibold transition-colors',
            atual === 'bom'
              ? 'border-ok bg-ok/8 text-ok'
              : 'border-line bg-surface text-text-2 hover:border-line-strong',
          )}
        >
          👍 Resposta boa
        </button>
        <button
          type="button"
          disabled={salvando}
          onClick={() => setAbertoRuim(true)}
          className={cn(
            'h-10 flex-1 rounded-[9px] border text-[13px] font-semibold transition-colors',
            atual === 'ruim' || abertoRuim
              ? 'border-brand bg-brand/7 text-brand'
              : 'border-line bg-surface text-text-2 hover:border-line-strong',
          )}
        >
          👎 Podia ser melhor
        </button>
      </div>
      {abertoRuim && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-1.5">
            {MOTIVOS_FEEDBACK.map((m) => {
              const on = motivos.includes(m.codigo);
              return (
                <button
                  key={m.codigo}
                  type="button"
                  onClick={() =>
                    setMotivos((v) => (on ? v.filter((x) => x !== m.codigo) : [...v, m.codigo]))
                  }
                  className={cn(
                    'h-[26px] rounded-full border px-2.5 text-xs transition-colors',
                    on
                      ? 'border-ink bg-ink text-white'
                      : 'border-line bg-surface text-text-2 hover:border-ink',
                  )}
                >
                  {m.rotulo}
                </button>
              );
            })}
          </div>
          <Textarea
            rows={3}
            value={sugestao}
            onChange={(e) => setSugestao(e.target.value)}
            placeholder="Como o agente deveria ter respondido?"
          />
          <Button
            variant="ink"
            onClick={() => salvar('ruim')}
            disabled={salvando}
            className="self-start"
          >
            {salvando ? 'Salvando…' : atual === 'ruim' ? 'Atualizar feedback' : 'Salvar feedback'}
          </Button>
        </div>
      )}
      {erro && <p className="m-0 text-xs text-brand">{erro}</p>}
      <p className="m-0 text-xs text-text-3">
        {trace.feedback ? 'Feedback registrado. ' : ''}O feedback vira sinal de aprendizado: o
        distiller usa o par pergunta → resposta sugerida na próxima rodada de propostas.
      </p>
    </Card>
  );
}

function SeletorConversa() {
  const router = useRouter();
  const [busca, setBusca] = useState('');
  const [conversas, setConversas] = useState<ConversaResumo[]>([]);
  useEffect(() => {
    const timer = setTimeout(() => {
      api
        .conversas('todas', busca)
        .then((r) => setConversas(r.conversas))
        .catch(() => {});
    }, 250);
    return () => clearTimeout(timer);
  }, [busca]);
  return (
    <>
      <div className="flex flex-col gap-2.5 border-b border-line p-4">
        <h2 className="m-0 font-heading text-[17px] font-semibold tracking-[-.02em]">
          Aprendizado
        </h2>
        <p className="m-0 text-xs text-text-3">
          Escolha uma conversa para ver os turnos do agente.
        </p>
        <Input
          compacto
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          placeholder="Buscar por nome ou telefone"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {conversas.map((c) => (
          <button
            key={c.conversaId}
            type="button"
            onClick={() => router.replace(`/aprendizado?c=${c.conversaId}`)}
            className="flex w-full flex-col gap-0.5 border-b border-line-soft px-4 py-2.5 text-left hover:bg-surface-2"
          >
            <span className="flex justify-between gap-2">
              <span className="truncate text-[13px] font-semibold">
                {nomeExibicao(c.contatoNome, c.waId)}
              </span>
              <span className="font-mono text-[10.5px] text-text-3">
                {c.ultimaMensagem ? horarioLista(c.ultimaMensagem.em) : ''}
              </span>
            </span>
            <span className="truncate text-xs text-text-3">
              {c.ultimaMensagem?.texto ?? telefoneBonito(c.waId)}
            </span>
          </button>
        ))}
        {conversas.length === 0 && <p className="p-4 text-xs text-text-3">Nenhuma conversa.</p>}
      </div>
    </>
  );
}

function Explorador({
  conversaId,
  traceInicial,
}: {
  conversaId: string;
  traceInicial: string | null;
}) {
  const router = useRouter();
  const [conversa, setConversa] = useState<ConversaDetalhe | null>(null);
  const [traces, setTraces] = useState<TraceTurnoView[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [filtro, setFiltro] = useState<FiltroTurno>('todos');
  const [sel, setSel] = useState<string | null>(traceInicial);

  useEffect(() => {
    setTraces(null);
    setConversa(null);
    api
      .conversa(conversaId)
      .then((d) => {
        setConversa(d);
        return api.traces(d.ticket.id);
      })
      .then((r) => {
        setTraces(r.traces);
        setSel((prev) =>
          prev && r.traces.some((t) => t.id === prev) ? prev : (r.traces.at(-1)?.id ?? null),
        );
      })
      .catch((e) => setErro(e instanceof Error ? e.message : String(e)));
  }, [conversaId]);

  const visiveis = useMemo(() => (traces ?? []).filter((t) => passa(t, filtro)), [traces, filtro]);
  const atual = traces?.find((t) => t.id === sel) ?? null;
  const n = atual && traces ? traces.indexOf(atual) + 1 : 0;
  const nome = conversa ? nomeExibicao(conversa.contatoNome, conversa.waId) : '…';
  const conta = (f: FiltroTurno) => (traces ?? []).filter((t) => passa(t, f)).length;

  function aoSalvo(traceId: string, fb: FeedbackTurno) {
    setTraces((prev) => prev?.map((t) => (t.id === traceId ? { ...t, feedback: fb } : t)) ?? prev);
  }

  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(280px,400px)_minmax(0,1fr)] overflow-hidden">
      <aside className="flex h-full min-h-0 flex-col border-r border-line bg-surface">
        <div className="flex flex-col gap-2.5 border-b border-line p-4">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="m-0 font-heading text-[17px] font-semibold tracking-[-.02em]">
              Aprendizado
            </h2>
            <span className="truncate font-mono text-[11px] text-text-3">
              {nome} · {traces ? `${traces.length} turno${traces.length === 1 ? '' : 's'}` : '…'}
            </span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <Filtros<FiltroTurno>
              itens={[
                { id: 'todos', rotulo: 'Todos', n: conta('todos') },
                { id: 'escalados', rotulo: 'Escalados', n: conta('escalados') },
                { id: 'feedback', rotulo: 'Com feedback', n: conta('feedback') },
                { id: 'tool', rotulo: 'Com tool', n: conta('tool') },
                { id: 'fallback', rotulo: 'Fallback', n: conta('fallback') },
              ]}
              ativo={filtro}
              aoMudar={setFiltro}
            />
          </div>
          <Link href="/aprendizado" className="text-xs text-text-3 hover:text-brand">
            ← trocar de conversa
          </Link>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {visiveis.map((t) => {
            const idx = (traces ?? []).indexOf(t) + 1;
            const on = t.id === sel;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => {
                  setSel(t.id);
                  router.replace(`/aprendizado?c=${conversaId}&t=${t.id}`);
                }}
                className={cn(
                  'flex w-full flex-col gap-1 border-b border-l-[3px] border-line-soft px-4 py-3 text-left hover:bg-surface-2',
                  on ? 'border-l-brand bg-background' : 'border-l-transparent',
                )}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[11px] text-text-3">
                    #{idx} · {hora(t.criadoEm)}
                  </span>
                  <span className="flex gap-1">
                    {t.escalado && <Chip papel="warn">escalado</Chip>}
                    {t.fallback && <Chip papel="risk">fallback</Chip>}
                    {t.feedback && (
                      <Chip papel={t.feedback.avaliacao === 'bom' ? 'ok' : 'risk'}>
                        {t.feedback.avaliacao === 'bom' ? '👍' : '👎'}
                      </Chip>
                    )}
                  </span>
                </span>
                <span className="w-full truncate text-[13px] font-semibold">
                  “{t.textoTurno ?? '—'}”
                </span>
                <span className="font-mono text-[10.5px] text-text-3">
                  {t.tokensEntrada} in · {t.tokensSaida} out · {t.latenciaMs} ms
                </span>
              </button>
            );
          })}
          {traces && visiveis.length === 0 && (
            <p className="p-4 text-xs text-text-3">
              {traces.length === 0
                ? 'O agente ainda não processou turnos nesta conversa.'
                : 'Nenhum turno neste filtro.'}
            </p>
          )}
          {!traces && !erro && <p className="p-4 text-xs text-text-3">Carregando…</p>}
          {erro && <p className="p-4 text-xs text-brand">{erro}</p>}
        </div>
      </aside>

      <section className="flex min-w-0 flex-col gap-5 overflow-y-auto px-8 py-7">
        {atual ? (
          <>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <Eyebrow className="mb-1.5">
                  Turno #{n} · {atual.traceId}
                </Eyebrow>
                <h1 className="m-0 font-heading text-[22px] font-semibold tracking-[-.02em]">
                  “{atual.textoTurno ?? '—'}”
                </h1>
              </div>
              <Link href={`/inbox?c=${conversaId}`} className="text-[13px] font-semibold">
                Abrir conversa →
              </Link>
            </div>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {[
                ['Tokens de entrada', String(atual.tokensEntrada), ''],
                ['Tokens de saída', String(atual.tokensSaida), ''],
                ['Latência', `${atual.latenciaMs} ms`, ''],
                [
                  'Resultado',
                  atual.escalado ? 'Escalado' : atual.fallback ? 'Fallback' : 'Respondeu',
                  atual.escalado ? 'text-warn' : atual.fallback ? 'text-brand' : 'text-ok',
                ],
              ].map(([rotulo, valor, cor]) => (
                <Card key={rotulo} className="px-3.5 py-3">
                  <div className="text-[11px] text-text-3">{rotulo}</div>
                  <div className={cn('font-heading text-xl font-semibold', cor)}>{valor}</div>
                </Card>
              ))}
            </div>
            <Card className="flex flex-col p-5">
              <Eyebrow className="mb-2.5">Linha de eventos</Eyebrow>
              <LinhaEvento e={{ tipo: 'contexto', ...atual.contexto }} />
              {atual.eventos
                .filter((e) => e.tipo !== 'contexto')
                .map((e, j) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: eventos são imutáveis e ordenados
                  <LinhaEvento key={j} e={e} />
                ))}
              {atual.fallbackMotivo && (
                <p className="m-0 mt-2 text-xs text-brand">
                  motivo do fallback: {atual.fallbackMotivo}
                </p>
              )}
            </Card>
            <div className="grid gap-4 lg:grid-cols-2">
              <Card className="flex flex-col gap-2.5 p-5">
                <Eyebrow>Resposta do agente</Eyebrow>
                <div className="whitespace-pre-wrap rounded-[14px_4px_14px_14px] border border-ok/18 bg-balao-agente px-3 py-2.5 text-[13.5px]">
                  {atual.resposta || '—'}
                </div>
              </Card>
              <Feedback trace={atual} aoSalvo={aoSalvo} />
            </div>
          </>
        ) : (
          <Vazio
            texto={
              traces && traces.length === 0
                ? 'Sem turnos do agente nesta conversa ainda.'
                : 'Selecione um turno à esquerda.'
            }
          />
        )}
      </section>
    </div>
  );
}

function AprendizadoConteudo() {
  const params = useSearchParams();
  const sessao = useSessao();
  const c = params.get('c');
  const t = params.get('t');
  const v = params.get('v');
  const curador = sessao?.role === 'curador';
  const emCuradoria = curador && v === 'curadoria';

  return (
    <div className="flex h-full min-h-0 flex-col">
      {curador && (
        <div className="flex shrink-0 gap-1 border-b border-line bg-surface px-4">
          {[
            {
              id: 'turnos',
              rotulo: 'Turnos do agente',
              href: c ? `/aprendizado?c=${c}` : '/aprendizado',
            },
            {
              id: 'curadoria',
              rotulo: 'Curadoria (propostas e skills)',
              href: '/aprendizado?v=curadoria',
            },
          ].map((aba) => {
            const on = aba.id === 'curadoria' ? emCuradoria : !emCuradoria;
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
      )}
      <div className="min-h-0 flex-1">
        {emCuradoria ? (
          <Curadoria />
        ) : c ? (
          <Explorador key={c} conversaId={c} traceInicial={t} />
        ) : (
          <div className="grid h-full min-h-0 grid-cols-[minmax(280px,400px)_minmax(0,1fr)] overflow-hidden">
            <aside className="flex h-full min-h-0 flex-col border-r border-line bg-surface">
              <SeletorConversa />
            </aside>
            <section className="flex items-center justify-center p-8">
              <Vazio
                className="max-w-md"
                titulo="Turnos do agente"
                texto="Cada turno mostra o contexto montado, as tools chamadas, os guardrails e a resposta. Escolha uma conversa à esquerda — ou abra pelo botão “Ver histórico do agente” no atendimento."
              />
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

export default function AprendizadoPage() {
  return (
    <Suspense fallback={<main className="p-6 text-sm text-text-3">Carregando…</main>}>
      <AprendizadoConteudo />
    </Suspense>
  );
}
