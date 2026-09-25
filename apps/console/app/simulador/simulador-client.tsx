'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Chip, Eyebrow, Ponto } from '@/components/ui/chip';
import { Campo, Input } from '@/components/ui/input';
import { api } from '@/lib/console-api';
import { hora, iniciais, telefoneBonito } from '@/lib/formatos';
import { cn } from '@/lib/utils';

/**
 * Simulador de WhatsApp (plano B da demo): injeta mensagens no mesmo caminho
 * do webhook e acompanha a conversa via SSE. Requer DEV_SIMULATOR=true no server.
 * Visual do design: tela de celular com o fundo bege do WhatsApp — você fala
 * como o cotista (direita) e vê o agente responder (esquerda).
 */

interface MensagemEvento {
  id: string;
  direcao: 'in' | 'out';
  texto: string;
  status: string;
  criadoEm: string;
}

interface TurnoEvento {
  id: string;
  textoAgregado: string;
}

type Evento = { tipo: 'mensagem'; dados: MensagemEvento } | { tipo: 'turno'; dados: TurnoEvento };

const WA_ID_PADRAO = '5511999990001';

function Checks({ status }: { status: string }) {
  if (status === 'recebida') return null;
  if (status === 'pendente') return <span title="pendente">🕓</span>;
  if (status === 'falha') return <span className="text-brand">⚠</span>;
  const dois = status === 'entregue' || status === 'lida';
  return <span className={cn(status === 'lida' && 'text-info-2')}>{dois ? '✓✓' : '✓'}</span>;
}

export default function SimuladorClient() {
  const [waId, setWaId] = useState(WA_ID_PADRAO);
  const [conectado, setConectado] = useState(false);
  const [texto, setTexto] = useState('');
  const [eventos, setEventos] = useState<Evento[]>([]);
  const [instalacao, setInstalacao] = useState<string | null>(null);
  /**
   * Estado transitório, e por isso FORA da lista de eventos: quem decide é o
   * servidor (`estadoDigitando` em `dev-routes.ts`), que enxerga turno aberto sem
   * resposta enviada — o mesmo estado que acende o indicador no WhatsApp real.
   */
  const [digitando, setDigitando] = useState(false);
  const fimRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.instalacaoPublica().then((i) => setInstalacao(i?.nome ?? null));
  }, []);

  useEffect(() => {
    const vistos = new Set<string>();
    setEventos([]);
    setDigitando(false);
    const es = new EventSource(`/api-dev/dev/events?waId=${encodeURIComponent(waId)}`);
    es.onopen = () => setConectado(true);
    es.onerror = () => {
      setConectado(false);
      setDigitando(false); // stream caiu: não deixar a bolha pendurada
    };
    es.addEventListener('digitando', (ev) => {
      setDigitando((JSON.parse(ev.data) as { ativo: boolean }).ativo);
    });
    es.addEventListener('mensagem', (ev) => {
      const dados = JSON.parse(ev.data) as MensagemEvento;
      if (vistos.has(dados.id)) return;
      vistos.add(dados.id);
      setEventos((prev) => [...prev, { tipo: 'mensagem', dados }]);
    });
    es.addEventListener('turno', (ev) => {
      const dados = JSON.parse(ev.data) as TurnoEvento;
      if (vistos.has(dados.id)) return;
      vistos.add(dados.id);
      setEventos((prev) => [...prev, { tipo: 'turno', dados }]);
    });
    return () => es.close();
  }, [waId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: rolar ao fim a cada evento novo é o efeito desejado
  useEffect(() => {
    fimRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [eventos, digitando]);

  const enviar = useCallback(async () => {
    const corpo = texto.trim();
    if (!corpo) return;
    setTexto('');
    await fetch('/api-dev/dev/inbound', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ waId, text: corpo }),
    });
  }, [texto, waId]);

  return (
    <main className="mx-auto flex h-dvh w-full max-w-[720px] flex-col gap-4 px-6 py-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Eyebrow className="mb-1.5">Simulador · só em dev</Eyebrow>
          <h1 className="m-0 flex items-center gap-3 font-heading text-[26px] font-semibold tracking-[-.02em]">
            WhatsApp do cotista
            <Chip papel={conectado ? 'ok' : 'risk'} tamanho="md">
              <Ponto tom={conectado ? 'ok' : 'risk'} className="mr-1.5" />
              {conectado ? 'ao vivo' : 'desconectado'}
            </Chip>
          </h1>
          <p className="m-0 mt-1 text-[12.5px] text-text-3">
            A mensagem entra pelo mesmo caminho do webhook (idempotência + debounce); o agente
            responde aqui e no <Link href="/inbox">atendimento</Link>.
          </p>
        </div>
        <Campo rotulo="Número (wa_id)">
          <Input
            compacto
            mono
            className="w-48"
            value={waId}
            onChange={(e) => setWaId(e.target.value.replace(/\D/g, ''))}
            aria-label="wa_id do contato"
          />
        </Campo>
      </header>

      <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[18px] border border-line bg-whatsapp">
        <div className="flex items-center gap-3 border-b border-line/60 bg-surface px-4 py-2.5">
          <span className="flex size-9 items-center justify-center rounded-full bg-ink font-heading text-xs font-semibold text-white">
            {instalacao ? iniciais(instalacao) : 'IA'}
          </span>
          <div className="min-w-0">
            <div className="truncate text-[13.5px] font-semibold">{instalacao ?? 'Agente'}</div>
            <div className="font-mono text-[10.5px] text-text-3">você é {telefoneBonito(waId)}</div>
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-4 py-4">
          {eventos.length === 0 && (
            <p className="m-0 self-center rounded-full border border-line bg-surface px-3 py-1 font-mono text-[10.5px] text-text-3">
              escreva como o cotista para começar
            </p>
          )}
          {eventos.map((ev) =>
            ev.tipo === 'mensagem' ? (
              <div
                key={ev.dados.id}
                className={cn(
                  'flex max-w-[min(520px,88%)] flex-col gap-[3px]',
                  ev.dados.direcao === 'in' ? 'self-end' : 'self-start',
                )}
              >
                {ev.dados.direcao === 'out' && (
                  <span className="pl-1 font-mono text-[10px] uppercase tracking-[.08em] text-ok">
                    Agente
                  </span>
                )}
                <div
                  className={cn(
                    'whitespace-pre-wrap break-words px-3 py-2 text-[13.5px] text-ink shadow-[0_1px_2px_rgba(20,20,22,.08)]',
                    ev.dados.direcao === 'in'
                      ? 'rounded-[14px_4px_14px_14px] bg-[#dcf8c6]'
                      : 'rounded-[4px_14px_14px_14px] bg-surface',
                  )}
                >
                  {ev.dados.texto}
                </div>
                <div className="flex justify-end gap-1.5 pr-1 font-mono text-[10px] text-text-3">
                  {hora(ev.dados.criadoEm)}
                  <Checks status={ev.dados.status} />
                </div>
              </div>
            ) : (
              <p
                key={ev.dados.id}
                className="m-0 my-1 self-center rounded-full border border-line bg-surface px-3 py-[3px] font-mono text-[10.5px] text-text-3"
              >
                turno agregado · “{ev.dados.textoAgregado.replaceAll('\n', ' · ')}”
              </p>
            ),
          )}
          {digitando && (
            <div className="flex max-w-[min(520px,88%)] flex-col gap-[3px] self-start">
              <span className="pl-1 font-mono text-[10px] uppercase tracking-[.08em] text-ok">
                Agente
              </span>
              <div
                className="flex items-center gap-1 rounded-[4px_14px_14px_14px] bg-surface px-3 py-[11px] shadow-[0_1px_2px_rgba(20,20,22,.08)]"
                aria-label="digitando"
                role="status"
              >
                {[0, 150, 300].map((atraso) => (
                  <span
                    key={atraso}
                    className="size-[6px] rounded-full bg-text-3 motion-safe:animate-bounce"
                    style={{ animationDelay: `${atraso}ms` }}
                  />
                ))}
              </div>
            </div>
          )}
          <div ref={fimRef} />
        </div>
        <form
          className="flex items-end gap-2.5 border-t border-line/60 bg-surface px-4 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            void enviar();
          }}
        >
          <Input
            compacto
            className="flex-1 h-10 rounded-full bg-background"
            placeholder="Mensagem do cotista…"
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
            aria-label="Mensagem do cotista"
          />
          <Button type="submit" size="md" className="h-10 rounded-full" disabled={!texto.trim()}>
            Enviar
          </Button>
        </form>
      </section>
    </main>
  );
}
