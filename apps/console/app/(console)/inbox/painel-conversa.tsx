'use client';

import { useEffect, useRef, useState } from 'react';
import {
  type ConversaDetalhe,
  type MensagemThread,
  type Sessao,
  STATUS_LABEL,
} from '@/lib/console-api';
import { estadoJanela, prefixoSeAplica, separadorDia, telefoneBonito } from '@/lib/formatos';
import { cn } from '@/lib/utils';
import { TraceViewer } from './trace-viewer';

/** Coluna direita (#45): thread da conversa, ações HITL e caixa de resposta. */

const BALAO_AUTOR: Record<MensagemThread['autor'], string> = {
  contato: 'bg-muted',
  bot: 'bg-sky-600/15 dark:bg-sky-400/15',
  atendente: 'bg-emerald-600/90 text-white',
  campanha: 'bg-violet-600/15 dark:bg-violet-400/15',
};

const ROTULO_AUTOR: Record<MensagemThread['autor'], string> = {
  contato: 'cliente',
  bot: 'bot',
  atendente: 'atendente',
  campanha: 'disparo',
};

function Checks({ status }: { status: MensagemThread['status'] }) {
  if (status === 'recebida') return null;
  if (status === 'pendente') return <span title="pendente">🕓</span>;
  if (status === 'falha')
    return (
      <span className="text-red-300" title="falha no envio">
        ⚠
      </span>
    );
  const dois = status === 'entregue' || status === 'lida';
  return (
    <span className={cn(status === 'lida' && 'text-sky-300')} title={status}>
      {dois ? '✓✓' : '✓'}
    </span>
  );
}

function Balao({ m }: { m: MensagemThread }) {
  const doContato = m.autor === 'contato';
  return (
    <div className={cn('flex', doContato ? 'justify-start' : 'justify-end')}>
      <div className={cn('max-w-[75%] rounded-lg px-3 py-2 text-sm', BALAO_AUTOR[m.autor])}>
        {m.autor === 'atendente' && m.atendenteNome && (
          <p className="text-[10px] font-semibold opacity-90">{m.atendenteNome}</p>
        )}
        <p className="whitespace-pre-wrap">{m.texto}</p>
        <p className="mt-1 flex items-center justify-end gap-1 text-[10px] opacity-70">
          {ROTULO_AUTOR[m.autor]} ·{' '}
          {new Date(m.criadoEm).toLocaleTimeString('pt-BR', {
            hour: '2-digit',
            minute: '2-digit',
          })}{' '}
          <Checks status={m.status} />
        </p>
      </div>
    </div>
  );
}

function Thread({
  mensagens,
  temMais,
  carregandoMais,
  aoCarregarMais,
}: {
  mensagens: MensagemThread[];
  temMais: boolean;
  carregandoMais: boolean;
  aoCarregarMais: () => void;
}) {
  const areaRef = useRef<HTMLDivElement>(null);
  const fimRef = useRef<HTMLDivElement>(null);
  const alturaAntesRef = useRef<number | null>(null);
  const ultimaIdRef = useRef<string | null>(null);

  // âncora na mais recente: rola ao fim quando chega mensagem NOVA no rabo;
  // preserva a posição quando uma página antiga é PREPENDIDA
  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    if (alturaAntesRef.current !== null) {
      area.scrollTop += area.scrollHeight - alturaAntesRef.current;
      alturaAntesRef.current = null;
      return;
    }
    const ultima = mensagens.at(-1)?.id ?? null;
    if (ultima !== ultimaIdRef.current) {
      ultimaIdRef.current = ultima;
      fimRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [mensagens]);

  const aoRolar = () => {
    const area = areaRef.current;
    if (!area || !temMais || carregandoMais) return;
    if (area.scrollTop < 80) {
      alturaAntesRef.current = area.scrollHeight;
      aoCarregarMais();
    }
  };

  let diaAnterior: string | null = null;
  return (
    <div ref={areaRef} onScroll={aoRolar} className="flex-1 space-y-2 overflow-y-auto p-4">
      {temMais && (
        <p className="text-center text-[11px] text-muted-foreground">
          {carregandoMais ? 'Carregando…' : 'Role para cima para ver mensagens anteriores'}
        </p>
      )}
      {mensagens.map((m) => {
        const dia = separadorDia(m.criadoEm);
        const mostraDia = dia !== diaAnterior;
        diaAnterior = dia;
        return (
          <div key={m.id} className="space-y-2">
            {mostraDia && (
              <div className="flex justify-center">
                <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                  {dia}
                </span>
              </div>
            )}
            <Balao m={m} />
          </div>
        );
      })}
      <div ref={fimRef} />
    </div>
  );
}

export function PainelConversa({
  detalhe,
  mensagens,
  temMais,
  carregandoMais,
  sessao,
  aoCarregarMais,
  aoAgir,
  aoResponder,
}: {
  detalhe: ConversaDetalhe;
  mensagens: MensagemThread[];
  temMais: boolean;
  carregandoMais: boolean;
  sessao: Sessao | null;
  aoCarregarMais: () => void;
  aoAgir: (acao: 'assumir' | 'devolver' | 'resolver') => Promise<void>;
  aoResponder: (texto: string) => Promise<void>;
}) {
  const [aba, setAba] = useState<'conversa' | 'trace'>('conversa');
  const [texto, setTexto] = useState('');
  const [erro, setErro] = useState<string | null>(null);

  const t = detalhe.ticket;
  const minhaPosse = t.status === 'humano_ativo' && t.atendenteId === sessao?.userId;
  const janela = estadoJanela(detalhe.janelaExpiraEm);
  const janelaFechada = janela.estado === 'fechada';

  // orçamento: o prefixo *Nome* conta quando esta resposta vai abrir a fala
  const comPrefixo = prefixoSeAplica(mensagens, sessao?.userId);
  const custoPrefixo = comPrefixo && sessao ? `*${sessao.nome}*\n\n`.length : 0;
  const restantes = detalhe.limiteResposta - custoPrefixo - texto.length;

  const podeEnviar = minhaPosse && !janelaFechada;
  const motivoBloqueio = janelaFechada
    ? 'Janela de 24h fechada — a Meta só aceita template de reengajamento.'
    : t.status === 'aguardando_humano'
      ? 'Assuma a conversa para responder.'
      : t.status === 'humano_ativo'
        ? `Em atendimento por ${t.atendenteNome ?? 'outro atendente'}.`
        : t.status === 'resolvido'
          ? 'Conversa resolvida — reabre quando o contato mandar mensagem.'
          : 'O bot está atendendo — responda só depois que a conversa for escalada e assumida.';

  async function agir(acao: 'assumir' | 'devolver' | 'resolver') {
    setErro(null);
    try {
      await aoAgir(acao);
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e));
    }
  }

  async function enviar(e: React.FormEvent) {
    e.preventDefault();
    const corpo = texto.trim();
    if (!corpo || restantes < 0) return;
    setTexto('');
    setErro(null);
    try {
      await aoResponder(corpo);
    } catch (err) {
      setErro(err instanceof Error ? err.message : String(err));
    }
  }

  const perfil = detalhe.perfilErp as {
    tier?: string;
    status?: string;
    periodos?: number;
    pontos?: number;
    cota_codigo?: string;
    bloco?: string;
    uh?: string;
  } | null;

  return (
    <section className="grid h-full grid-cols-1 gap-0 overflow-hidden xl:grid-cols-[1fr_260px]">
      <div className="flex h-full flex-col overflow-hidden">
        <header className="flex flex-wrap items-center gap-2 border-b px-4 py-2 text-sm">
          <div className="min-w-0">
            <p className="truncate font-medium">
              {detalhe.contatoNome ?? telefoneBonito(detalhe.waId)}
            </p>
            <p className="text-[11px] text-muted-foreground">{telefoneBonito(detalhe.waId)}</p>
          </div>
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs">
            {STATUS_LABEL[t.status]}
            {t.status === 'humano_ativo' && t.atendenteNome ? ` · ${t.atendenteNome}` : ''}
          </span>
          {janela.estado === 'fechando' && (
            <span className="rounded-full bg-orange-500/15 px-2 py-0.5 text-xs text-orange-600">
              janela {janela.rotulo}
            </span>
          )}
          {janelaFechada && (
            <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-xs text-red-600">
              janela 24h fechada
            </span>
          )}
          <div className="flex rounded-md border text-xs">
            {(['conversa', 'trace'] as const).map((nome) => (
              <button
                key={nome}
                type="button"
                onClick={() => setAba(nome)}
                className={cn('px-2 py-1 capitalize', aba === nome && 'bg-muted font-medium')}
              >
                {nome}
              </button>
            ))}
          </div>
          <div className="ml-auto flex gap-2">
            {t.status === 'aguardando_humano' && (
              <button
                type="button"
                onClick={() => agir('assumir')}
                className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground"
              >
                Assumir
              </button>
            )}
            {minhaPosse && (
              <>
                <button
                  type="button"
                  onClick={() => agir('devolver')}
                  className="rounded-md border px-3 py-1 text-xs"
                >
                  Devolver ao bot
                </button>
                <button
                  type="button"
                  onClick={() => agir('resolver')}
                  className="rounded-md border px-3 py-1 text-xs"
                >
                  Resolver
                </button>
              </>
            )}
          </div>
        </header>

        {aba === 'trace' ? (
          <div className="flex-1 overflow-y-auto">
            <TraceViewer ticketId={t.id} />
          </div>
        ) : (
          <Thread
            mensagens={mensagens}
            temMais={temMais}
            carregandoMais={carregandoMais}
            aoCarregarMais={aoCarregarMais}
          />
        )}

        <form onSubmit={enviar} className={cn('border-t p-3', aba !== 'conversa' && 'hidden')}>
          {!podeEnviar && <p className="mb-2 text-xs text-muted-foreground">{motivoBloqueio}</p>}
          <div className="flex gap-2">
            <input
              className="flex-1 rounded-md border bg-transparent px-3 py-2 text-sm disabled:opacity-50"
              placeholder={podeEnviar ? 'Responder como atendente…' : ''}
              disabled={!podeEnviar}
              value={texto}
              onChange={(e) => setTexto(e.target.value)}
            />
            <button
              type="submit"
              disabled={!podeEnviar || !texto.trim() || restantes < 0}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              Enviar
            </button>
          </div>
          {podeEnviar && (
            <p
              className={cn(
                'mt-1 text-right text-[11px]',
                restantes < 0 ? 'text-red-600' : 'text-muted-foreground',
              )}
            >
              {comPrefixo && 'seu nome abre a mensagem · '}
              {restantes} caracteres restantes
            </p>
          )}
          {erro && <p className="mt-1 text-xs text-red-600">{erro}</p>}
        </form>
      </div>

      <aside className="hidden border-l p-4 text-sm xl:block">
        <h3 className="font-semibold">Contrato (ERP)</h3>
        {perfil ? (
          <dl className="mt-2 space-y-1 text-xs">
            <div>
              <dt className="text-muted-foreground">Produto</dt>
              <dd>{perfil.tier}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Cota / UH</dt>
              <dd>
                {perfil.cota_codigo} — {perfil.bloco}, UH {perfil.uh}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Status</dt>
              <dd className="capitalize">{perfil.status}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Períodos / pontos</dt>
              <dd>
                {perfil.periodos ?? '—'} período(s) · {perfil.pontos ?? '—'} pontos
              </dd>
            </div>
          </dl>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">Sem vínculo ou ERP indisponível.</p>
        )}
        <h3 className="mt-6 font-semibold">Escalonamento</h3>
        <p className="mt-2 text-xs text-muted-foreground">
          {t.motivoEscalonamento ?? 'Sem escalonamento registrado.'}
        </p>
      </aside>
    </section>
  );
}
