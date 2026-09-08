'use client';

import { useEffect, useRef } from 'react';
import { Chip } from '@/components/ui/chip';
import { Input } from '@/components/ui/input';
import { Filtros } from '@/components/ui/tabela';
import { Avatar } from '@/components/ui/whatsapp';
import type { ContagensConversas, ConversaResumo, FiltroConversas } from '@/lib/console-api';
import {
  duracao,
  estadoJanela,
  horarioLista,
  iniciais,
  nomeExibicao,
  prefixoAutor,
} from '@/lib/formatos';
import { STATUS_TICKET } from '@/lib/rotulos';
import { cn } from '@/lib/utils';

/** Coluna esquerda: fila de atendimento com busca, filtros com contagem e não-lidas. */

const FILTROS: { id: FiltroConversas; rotulo: string }[] = [
  { id: 'todas', rotulo: 'Todas' },
  { id: 'aguardando', rotulo: 'Aguardando humano' },
  { id: 'minhas', rotulo: 'Minhas' },
  { id: 'agente', rotulo: 'Com o agente' },
  { id: 'resolvidas', rotulo: 'Resolvidas' },
];

function ItemConversa({
  c,
  ativa,
  aoClicar,
}: {
  c: ConversaResumo;
  ativa: boolean;
  aoClicar: () => void;
}) {
  const st = STATUS_TICKET[c.status];
  const janela = estadoJanela(c.janelaExpiraEm);
  const nome = nomeExibicao(c.contatoNome, c.waId);
  const rotuloStatus =
    c.status === 'humano_ativo' && c.atendenteNome ? c.atendenteNome.split(' ')[0] : st.rotulo;
  return (
    <button
      type="button"
      onClick={aoClicar}
      className={cn(
        'grid w-full grid-cols-[38px_minmax(0,1fr)] gap-2.5 border-b border-l-[3px] border-line-soft px-3.5 py-3 text-left transition-colors hover:bg-surface-2',
        ativa
          ? 'border-l-brand bg-background'
          : c.status === 'aguardando_humano'
            ? 'border-l-warn-2'
            : 'border-l-transparent',
      )}
    >
      <Avatar iniciais={c.contatoNome ? iniciais(c.contatoNome) : '?'} />
      <span className="flex min-w-0 flex-col gap-[3px]">
        <span className="flex items-baseline justify-between gap-2">
          <span className="truncate text-[13.5px] font-semibold">{nome}</span>
          <span className="shrink-0 font-mono text-[10.5px] text-text-3">
            {c.ultimaMensagem ? horarioLista(c.ultimaMensagem.em) : ''}
          </span>
        </span>
        <span className="truncate text-[12.5px] text-text-2">
          {c.ultimaMensagem
            ? `${prefixoAutor(c.ultimaMensagem.autor, c.atendenteNome)}${c.ultimaMensagem.texto}`
            : 'Sem mensagens.'}
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-1.5">
          <Chip papel={st.papel}>{rotuloStatus}</Chip>
          {c.status === 'aguardando_humano' && c.esperaSegundos !== null && (
            <span className="font-mono text-[10.5px] text-warn">
              espera {duracao(c.esperaSegundos)}
            </span>
          )}
          {janela.estado === 'fechada' && <Chip papel="risk">janela 24h fechada</Chip>}
          {janela.estado === 'fechando' && <Chip papel="warn">{janela.rotulo}</Chip>}
          {c.naoLidas > 0 && (
            <span className="ml-auto inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-brand px-1.5 font-mono text-[10.5px] text-white">
              {c.naoLidas}
            </span>
          )}
        </span>
      </span>
    </button>
  );
}

export function ListaConversas({
  conversas,
  contagens,
  selecionada,
  filtro,
  busca,
  aoSelecionar,
  aoMudarFiltro,
  aoBuscar,
}: {
  conversas: ConversaResumo[];
  contagens: ContagensConversas | null;
  selecionada: string | null;
  filtro: FiltroConversas;
  busca: string;
  aoSelecionar: (c: ConversaResumo) => void;
  aoMudarFiltro: (f: FiltroConversas) => void;
  aoBuscar: (q: string) => void;
}) {
  const buscaRef = useRef<HTMLInputElement>(null);

  // "/" foca a busca (regra transversal do design), fora de campos de texto
  useEffect(() => {
    const aoTecla = (e: KeyboardEvent) => {
      const alvo = e.target as HTMLElement | null;
      const digitando =
        alvo && (alvo.tagName === 'INPUT' || alvo.tagName === 'TEXTAREA' || alvo.isContentEditable);
      if (e.key === '/' && !digitando) {
        e.preventDefault();
        buscaRef.current?.focus();
      }
    };
    window.addEventListener('keydown', aoTecla);
    return () => window.removeEventListener('keydown', aoTecla);
  }, []);

  const aguardando = contagens?.aguardando ?? 0;
  return (
    <section className="flex h-full min-h-0 flex-col border-r border-line bg-surface">
      <div className="flex flex-col gap-2.5 border-b border-line px-3.5 pt-3.5 pb-2.5">
        <div className="flex items-center justify-between">
          <h2 className="m-0 font-heading text-[17px] font-semibold tracking-[-.02em]">
            Atendimento
          </h2>
          <span className="font-mono text-[11px] text-text-3">{aguardando} aguardando</span>
        </div>
        <Input
          ref={buscaRef}
          compacto
          value={busca}
          onChange={(e) => aoBuscar(e.target.value)}
          placeholder="Buscar por nome ou telefone"
          aria-label="Buscar conversa"
        />
        <Filtros
          itens={FILTROS.map((f) => ({ ...f, n: contagens?.[f.id] }))}
          ativo={filtro}
          aoMudar={aoMudarFiltro}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {conversas.map((c) => (
          <ItemConversa
            key={c.conversaId}
            c={c}
            ativa={c.conversaId === selecionada}
            aoClicar={() => aoSelecionar(c)}
          />
        ))}
        {conversas.length === 0 && (
          <p className="p-4 text-center text-xs text-text-3">Nenhuma conversa aqui.</p>
        )}
      </div>
    </section>
  );
}
