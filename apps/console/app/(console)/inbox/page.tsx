'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  type ConversaDetalhe,
  type ConversaResumo,
  type FiltroConversas,
  type MensagemThread,
} from '@/lib/console-api';
import { mesclarMensagens } from '@/lib/formatos';
import { useSessao } from '../layout';
import { ListaConversas } from './lista-conversas';
import { PainelConversa } from './painel-conversa';

/**
 * Tela única de atendimento (#45), estilo WhatsApp Web: lista de conversas à
 * esquerda, thread à direita, sem navegação de página. A conversa aberta vai
 * na query (?c=) para deep-link; SSE alimenta lista e thread (polling é só
 * fallback), leitura é marcada ao abrir e a cada mensagem nova em tela.
 */

function InboxAtendimento() {
  const router = useRouter();
  const params = useSearchParams();
  const sessao = useSessao();

  const [conversas, setConversas] = useState<ConversaResumo[]>([]);
  const [filtro, setFiltro] = useState<FiltroConversas>('todas');
  const [busca, setBusca] = useState('');
  const [aoVivo, setAoVivo] = useState(false);
  const [detalhe, setDetalhe] = useState<ConversaDetalhe | null>(null);
  const [mensagens, setMensagens] = useState<MensagemThread[]>([]);
  const [temMais, setTemMais] = useState(false);
  const [carregandoMais, setCarregandoMais] = useState(false);

  const selecionada = params.get('c');
  const selecionadaRef = useRef<string | null>(null);
  selecionadaRef.current = selecionada;

  const recarregarListaRef = useRef<() => void>(() => {});
  const recarregarLista = useCallback(() => {
    api
      .conversas(filtro, busca)
      .then((r) => setConversas(r.conversas))
      .catch(() => {});
  }, [filtro, busca]);
  recarregarListaRef.current = recarregarLista;

  const marcarLida = useCallback((conversaId: string) => {
    api
      .marcarLida(conversaId)
      .then(() => recarregarListaRef.current())
      .catch(() => {});
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
        })
        .catch(() => {});
    },
    [marcarLida],
  );

  // seleção via URL (?c=) — deep-link e histórico do browser sem trocar de página
  // biome-ignore lint/correctness/useExhaustiveDependencies: reage só à conversa da URL
  useEffect(() => {
    if (selecionada) {
      setMensagens([]);
      setDetalhe(null);
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
      setAoVivo(true);
      pararPolling();
      recarregarListaRef.current();
    };
    es.onerror = () => {
      setAoVivo(false);
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
    <main className="grid h-full grid-cols-[320px_1fr] overflow-hidden">
      <ListaConversas
        conversas={conversas}
        selecionada={selecionada}
        filtro={filtro}
        busca={busca}
        aoVivo={aoVivo}
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
        />
      ) : (
        <section className="flex h-full items-center justify-center text-sm text-muted-foreground">
          {selecionada ? 'Carregando conversa…' : 'Selecione uma conversa para atender.'}
        </section>
      )}
    </main>
  );
}

export default function InboxPage() {
  // useSearchParams exige Suspense no App Router
  return (
    <Suspense fallback={<main className="p-4 text-sm">Carregando…</main>}>
      <InboxAtendimento />
    </Suspense>
  );
}
