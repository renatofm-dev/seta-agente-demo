'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  type CobrancaView,
  type ContagensConversas,
  type ConversaDetalhe,
  type ConversaResumo,
  type FiltroConversas,
  type MensagemThread,
  type ReservaView,
} from '@/lib/console-api';
import { mesclarMensagens } from '@/lib/formatos';
import { cn } from '@/lib/utils';
import { useSessao } from '../layout';
import { ListaConversas } from './lista-conversas';
import { PainelContexto } from './painel-contexto';
import { PainelConversa } from './painel-conversa';

/**
 * Atendimento (#45 + design 2026-09): três colunas — lista, thread e painel de
 * contexto (contrato, financeiro, cobranças da conversa, origem em campanha).
 * A conversa aberta vai na query (?c=) para deep-link; SSE alimenta lista e
 * thread (polling é só fallback), leitura é marcada ao abrir e a cada mensagem.
 * Abaixo de 1280px o painel de contexto vira um sobreposto aberto pelo botão.
 */

function InboxAtendimento() {
  const router = useRouter();
  const params = useSearchParams();
  const sessao = useSessao();

  const [conversas, setConversas] = useState<ConversaResumo[]>([]);
  const [contagens, setContagens] = useState<ContagensConversas | null>(null);
  const [filtro, setFiltro] = useState<FiltroConversas>('todas');
  const [busca, setBusca] = useState('');
  const [detalhe, setDetalhe] = useState<ConversaDetalhe | null>(null);
  const [mensagens, setMensagens] = useState<MensagemThread[]>([]);
  const [temMais, setTemMais] = useState(false);
  const [carregandoMais, setCarregandoMais] = useState(false);
  const [cobrancas, setCobrancas] = useState<CobrancaView[] | null | undefined>(undefined);
  const [reservas, setReservas] = useState<ReservaView[] | null | undefined>(undefined);
  const [contextoAberto, setContextoAberto] = useState(false);

  const selecionada = params.get('c');
  const selecionadaRef = useRef<string | null>(null);
  selecionadaRef.current = selecionada;

  const recarregarListaRef = useRef<() => void>(() => {});
  const recarregarLista = useCallback(() => {
    api
      .conversas(filtro, busca)
      .then((r) => {
        setConversas(r.conversas);
        setContagens(r.contagens);
      })
      .catch(() => {});
  }, [filtro, busca]);
  recarregarListaRef.current = recarregarLista;

  const marcarLida = useCallback((conversaId: string) => {
    api
      .marcarLida(conversaId)
      .then(() => recarregarListaRef.current())
      .catch(() => {});
  }, []);

  // aba Cobranças do painel: só as desta conversa; 404 = módulo de pagamentos desligado
  const carregarReservas = useCallback((conversaId: string) => {
    setReservas(undefined);
    api
      .reservas({ conversaId })
      .then((r) => {
        if (selecionadaRef.current === conversaId) setReservas(r.reservas);
      })
      // 404 = módulo de reserva desligado nesta instalação
      .catch(() => setReservas(null));
  }, []);

  const carregarCobrancas = useCallback((conversaId: string) => {
    api
      .cobrancas({ conversaId })
      .then((r) => {
        if (selecionadaRef.current === conversaId) setCobrancas(r.cobrancas);
      })
      .catch(() => setCobrancas(null));
  }, []);

  const abrirConversa = useCallback(
    (conversaId: string) => {
      api
        .conversa(conversaId)
        .then((d) => {
          // troca de conversa zera a thread; refetch da mesma mescla (status novo)
          setDetalhe(d);
          setMensagens((prev) =>
            selecionadaRef.current === conversaId && prev.some((m) => m.id === d.mensagens[0]?.id)
              ? mesclarMensagens(prev, d.mensagens)
              : d.mensagens,
          );
          setTemMais(d.temMais);
          marcarLida(conversaId);
          carregarCobrancas(conversaId);
          carregarReservas(conversaId);
        })
        .catch(() => {});
    },
    [marcarLida, carregarCobrancas, carregarReservas],
  );

  // seleção via URL (?c=) — deep-link e histórico do browser sem trocar de página
  // biome-ignore lint/correctness/useExhaustiveDependencies: reage só à conversa da URL
  useEffect(() => {
    if (selecionada) {
      setMensagens([]);
      setDetalhe(null);
      setCobrancas(undefined);
      setReservas(undefined);
      setContextoAberto(false);
      abrirConversa(selecionada);
    }
  }, [selecionada]);

  // lista: primeira carga + reação a filtro/busca (busca com debounce curto)
  useEffect(() => {
    const timer = setTimeout(recarregarLista, 250);
    return () => clearTimeout(timer);
  }, [recarregarLista]);

  // SSE único: eventos de mensagem/ticket recarregam a lista (throttle) e a
  // conversa aberta; status de entrega chega no refetch da thread
  useEffect(() => {
    const es = new EventSource('/api/console/events');
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    const pararPolling = () => {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };
    es.onopen = () => {
      pararPolling();
      recarregarListaRef.current();
    };
    es.onerror = () => {
      if (!pollTimer) {
        pollTimer = setInterval(() => {
          recarregarListaRef.current();
          if (selecionadaRef.current) abrirConversa(selecionadaRef.current);
        }, 3_000);
      }
    };
    let agendado: ReturnType<typeof setTimeout> | null = null;
    const aoEvento = (ev: MessageEvent) => {
      if (!agendado) {
        agendado = setTimeout(() => {
          agendado = null;
          recarregarListaRef.current();
        }, 500);
      }
      try {
        const dado = JSON.parse(String(ev.data)) as { conversaId?: string };
        if (dado.conversaId && dado.conversaId === selecionadaRef.current) {
          abrirConversa(dado.conversaId);
        }
      } catch {
        // pacote sem JSON: a recarga da lista acima já cobre
      }
    };
    es.addEventListener('ticket', aoEvento);
    es.addEventListener('mensagem', aoEvento);
    return () => {
      es.close();
      pararPolling();
      if (agendado) clearTimeout(agendado);
    };
  }, [abrirConversa]);

  const carregarMais = useCallback(() => {
    const primeira = mensagens[0];
    if (!selecionada || !primeira) return;
    setCarregandoMais(true);
    api
      .conversaMensagens(selecionada, primeira.criadoEm)
      .then((p) => {
        setMensagens((prev) => mesclarMensagens(p.mensagens, prev));
        setTemMais(p.temMais);
      })
      .catch(() => {})
      .finally(() => setCarregandoMais(false));
  }, [selecionada, mensagens]);

  const agir = useCallback(
    async (acao: 'assumir' | 'devolver' | 'resolver') => {
      if (!detalhe) return;
      await api.acao(detalhe.ticket.id, acao);
      abrirConversa(detalhe.conversaId);
    },
    [detalhe, abrirConversa],
  );

  const responder = useCallback(
    async (texto: string) => {
      if (!detalhe) return;
      await api.responder(detalhe.ticket.id, texto);
      abrirConversa(detalhe.conversaId);
    },
    [detalhe, abrirConversa],
  );

  return (
    <main className="grid h-full grid-cols-[minmax(220px,300px)_minmax(0,1fr)] overflow-hidden bg-background xl:grid-cols-[minmax(220px,300px)_minmax(0,1fr)_minmax(240px,320px)]">
      <ListaConversas
        conversas={conversas}
        contagens={contagens}
        selecionada={selecionada}
        filtro={filtro}
        busca={busca}
        aoSelecionar={(c) => router.replace(`/inbox?c=${c.conversaId}`)}
        aoMudarFiltro={setFiltro}
        aoBuscar={setBusca}
      />
      {detalhe ? (
        <PainelConversa
          detalhe={detalhe}
          mensagens={mensagens}
          temMais={temMais}
          carregandoMais={carregandoMais}
          sessao={sessao}
          aoCarregarMais={carregarMais}
          aoAgir={agir}
          aoResponder={responder}
          aoAbrirContexto={() => setContextoAberto(true)}
        />
      ) : (
        <section className="flex h-full items-center justify-center bg-surface-3 text-[13px] text-text-3">
          {selecionada ? 'Carregando conversa…' : 'Selecione uma conversa para atender.'}
        </section>
      )}
      {detalhe ? (
        <div
          className={cn(
            'min-h-0',
            contextoAberto
              ? 'fixed top-14 bottom-0 right-0 z-30 w-[320px] shadow-[-12px_0_32px_rgba(20,20,26,.12)] xl:static xl:z-auto xl:w-auto xl:shadow-none'
              : 'hidden xl:block',
          )}
        >
          <PainelContexto
            detalhe={detalhe}
            cobrancas={cobrancas}
            reservas={reservas}
            aoFechar={() => setContextoAberto(false)}
          />
        </div>
      ) : (
        <aside className="hidden border-l border-line bg-surface xl:block" />
      )}
    </main>
  );
}

export default function InboxPage() {
  // useSearchParams exige Suspense no App Router
  return (
    <Suspense fallback={<main className="p-4 text-sm text-text-3">Carregando…</main>}>
      <InboxAtendimento />
    </Suspense>
  );
}
