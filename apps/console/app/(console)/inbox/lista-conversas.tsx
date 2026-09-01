'use client';

import type { ConversaResumo, FiltroConversas } from '@/lib/console-api';
import { estadoJanela, horarioLista, iniciais, telefoneBonito } from '@/lib/formatos';
import { cn } from '@/lib/utils';

/** Coluna esquerda (#45): todas as conversas, busca, filtros e não-lidas. */

const FILTROS: { valor: FiltroConversas; rotulo: string }[] = [
  { valor: 'todas', rotulo: 'Todas' },
  { valor: 'aguardando', rotulo: 'Aguardando' },
  { valor: 'minhas', rotulo: 'Minhas' },
  { valor: 'resolvidas', rotulo: 'Resolvidas' },
];

const CHIP_STATUS: Record<ConversaResumo['status'], { rotulo: string; classe: string }> = {
  bot_ativo: { rotulo: 'Bot', classe: 'bg-sky-500/15 text-sky-600 dark:text-sky-400' },
  aguardando_humano: {
    rotulo: 'Aguardando',
    classe: 'bg-amber-500/20 text-amber-700 dark:text-amber-400',
  },
  humano_ativo: {
    rotulo: 'Em atendimento',
    classe: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  },
  resolvido: { rotulo: 'Resolvida', classe: 'bg-muted text-muted-foreground' },
};

function ItemConversa({
  c,
  ativa,
  aoClicar,
}: {
  c: ConversaResumo;
  ativa: boolean;
  aoClicar: () => void;
}) {
  const chip = CHIP_STATUS[c.status];
  const janela = estadoJanela(c.janelaExpiraEm);
  const nome = c.contatoNome ?? telefoneBonito(c.waId);
  return (
    <button
      type="button"
      onClick={aoClicar}
      className={cn(
        'flex w-full items-start gap-3 border-b px-3 py-2.5 text-left transition-colors hover:bg-muted/50',
        ativa && 'bg-muted/70',
        c.status === 'aguardando_humano' && 'border-l-2 border-l-amber-500',
      )}
    >
      <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
        {iniciais(nome)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className="truncate text-sm font-medium">{nome}</span>
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {c.ultimaMensagem ? horarioLista(c.ultimaMensagem.em) : ''}
          </span>
        </span>
        <span className="mt-0.5 flex items-center justify-between gap-2">
          <span className="truncate text-xs text-muted-foreground">
            {c.ultimaMensagem
              ? `${c.ultimaMensagem.autor === 'contato' ? '' : c.ultimaMensagem.autor === 'bot' ? 'Bot: ' : 'Você/atendente: '}${c.ultimaMensagem.texto}`
              : 'Sem mensagens.'}
          </span>
          {c.naoLidas > 0 && (
            <span className="shrink-0 rounded-full bg-emerald-500 px-1.5 py-0.5 text-[10px] font-semibold text-white">
              {c.naoLidas}
            </span>
          )}
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-1">
          <span className={cn('rounded-full px-1.5 py-0.5 text-[10px] font-medium', chip.classe)}>
            {chip.rotulo}
          </span>
          {c.status === 'humano_ativo' && c.atendenteNome && (
            <span className="truncate text-[10px] text-muted-foreground">
              com {c.atendenteNome}
            </span>
          )}
          {janela.estado === 'fechada' && (
            <span className="rounded-full bg-red-500/15 px-1.5 py-0.5 text-[10px] font-medium text-red-600">
              janela 24h fechada
            </span>
          )}
          {janela.estado === 'fechando' && (
            <span className="rounded-full bg-orange-500/15 px-1.5 py-0.5 text-[10px] font-medium text-orange-600">
              {janela.rotulo}
            </span>
          )}
        </span>
      </span>
    </button>
  );
}

export function ListaConversas({
  conversas,
  selecionada,
  filtro,
  busca,
  aoVivo,
  aoSelecionar,
  aoMudarFiltro,
  aoBuscar,
}: {
  conversas: ConversaResumo[];
  selecionada: string | null;
  filtro: FiltroConversas;
  busca: string;
  aoVivo: boolean;
  aoSelecionar: (c: ConversaResumo) => void;
  aoMudarFiltro: (f: FiltroConversas) => void;
  aoBuscar: (q: string) => void;
}) {
  return (
    <section className="flex h-full flex-col border-r">
      <div className="space-y-2 border-b p-2">
        <div className="flex items-center gap-2">
          <input
            value={busca}
            onChange={(e) => aoBuscar(e.target.value)}
            placeholder="Buscar por nome ou telefone…"
            className="w-full rounded-md border bg-transparent px-3 py-1.5 text-sm"
          />
          <span
            className={cn('h-2 w-2 shrink-0 rounded-full', aoVivo ? 'bg-green-500' : 'bg-red-500')}
            title={aoVivo ? 'ao vivo (SSE)' : 'polling'}
          />
        </div>
        <div className="flex gap-1">
          {FILTROS.map((f) => (
            <button
              key={f.valor}
              type="button"
              onClick={() => aoMudarFiltro(f.valor)}
              className={cn(
                'rounded-full border px-2.5 py-0.5 text-xs',
                filtro === f.valor
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'text-muted-foreground',
              )}
            >
              {f.rotulo}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {conversas.map((c) => (
          <ItemConversa
            key={c.conversaId}
            c={c}
            ativa={c.conversaId === selecionada}
            aoClicar={() => aoSelecionar(c)}
          />
        ))}
        {conversas.length === 0 && (
          <p className="p-4 text-xs text-muted-foreground">Nenhuma conversa aqui.</p>
        )}
      </div>
    </section>
  );
}
