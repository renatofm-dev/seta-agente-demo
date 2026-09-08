'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Chip, Ponto } from '@/components/ui/chip';
import { Textarea } from '@/components/ui/input';
import type { ConversaDetalhe, MensagemThread, Sessao } from '@/lib/console-api';
import {
  duracao,
  ehCodigoPagamento,
  estadoJanela,
  hora,
  nomeExibicao,
  prefixoSeAplica,
  semPrefixoAtendente,
  separadorDia,
  telefoneBonito,
} from '@/lib/formatos';
import { BALAO, motivoLabel, STATUS_TICKET } from '@/lib/rotulos';
import { cn } from '@/lib/utils';

/** Coluna central: cabeçalho com ações HITL, avisos, thread e caixa de resposta. */

function Checks({ status }: { status: MensagemThread['status'] }) {
  if (status === 'recebida') return null;
  if (status === 'pendente') return <span title="pendente">🕓</span>;
  if (status === 'falha')
    return (
      <span className="text-brand" title="falha no envio">
        ⚠
      </span>
    );
  const dois = status === 'entregue' || status === 'lida';
  return (
    <span className={cn(status === 'lida' && 'text-info-2')} title={status}>
      {dois ? '✓✓' : '✓'}
    </span>
  );
}

function Balao({ m }: { m: MensagemThread }) {
  const doContato = m.autor === 'contato';
  const b = BALAO[m.autor];
  const texto = m.autor === 'atendente' ? semPrefixoAtendente(m.texto) : m.texto;
  const mono = !doContato && ehCodigoPagamento(texto);
  const etiqueta = m.autor === 'atendente' ? (m.atendenteNome ?? b.etiqueta) : b.etiqueta;
  return (
    <div
      className={cn(
        'flex max-w-[min(560px,88%)] flex-col gap-[3px]',
        doContato ? 'self-start' : 'self-end',
      )}
    >
      {etiqueta && (
        <span
          className={cn('pl-1 font-mono text-[10px] uppercase tracking-[.08em]', b.etiquetaCor)}
        >
          {etiqueta}
        </span>
      )}
      <div
        className={cn(
          'whitespace-pre-wrap break-words border px-3 py-2 text-[13.5px] text-ink',
          b.classe,
          doContato ? 'rounded-[4px_14px_14px_14px]' : 'rounded-[14px_4px_14px_14px]',
          mono && 'break-all font-mono text-xs',
        )}
      >
        {texto}
      </div>
      <div className="flex justify-end gap-1.5 pr-1 font-mono text-[10px] text-text-3">
        {hora(m.criadoEm)}
        <Checks status={m.status} />
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
    <div
      ref={areaRef}
      onScroll={aoRolar}
      className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-5 py-4"
    >
      {temMais && (
        <p className="m-0 self-center font-mono text-[10.5px] text-text-3">
          {carregandoMais ? 'Carregando…' : 'Role para cima para ver mensagens anteriores'}
        </p>
      )}
      {mensagens.map((m) => {
        const dia = separadorDia(m.criadoEm);
        const mostraDia = dia !== diaAnterior;
        diaAnterior = dia;
        return (
          <div key={m.id} className="contents">
            {mostraDia && (
              <span className="my-1.5 self-center rounded-full border border-line bg-surface px-2.5 py-[3px] font-mono text-[10.5px] text-text-3">
                {dia}
              </span>
            )}
            <Balao m={m} />
          </div>
        );
      })}
      {mensagens.length === 0 && (
        <p className="m-0 self-center py-8 text-[13px] text-text-3">Sem mensagens ainda.</p>
      )}
      <div ref={fimRef} />
    </div>
  );
}

function Aviso({
  tom,
  pulsa,
  children,
}: {
  tom: 'warn' | 'risk';
  pulsa?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        'flex items-start gap-2 border-b px-[18px] py-2 text-[12.5px]',
        tom === 'warn'
          ? 'border-warn-2/35 bg-warn-2/14 text-warn'
          : 'border-brand/20 bg-brand/7 text-brand',
      )}
    >
      <Ponto tom={tom} pulsa={pulsa} className="mt-[5px]" />
      <span className="min-w-0 flex-1">{children}</span>
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
  aoAbrirContexto,
}: {
  detalhe: ConversaDetalhe;
  mensagens: MensagemThread[];
  temMais: boolean;
  carregandoMais: boolean;
  sessao: Sessao | null;
  aoCarregarMais: () => void;
  aoAgir: (acao: 'assumir' | 'devolver' | 'resolver') => Promise<void>;
  aoResponder: (texto: string) => Promise<void>;
  aoAbrirContexto: () => void;
}) {
  const [texto, setTexto] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  const t = detalhe.ticket;
  const minhaPosse = t.status === 'humano_ativo' && t.atendenteId === sessao?.userId;
  const janela = estadoJanela(detalhe.janelaExpiraEm);
  const janelaFechada = janela.estado === 'fechada';
  const st = STATUS_TICKET[t.status];
  const nome = nomeExibicao(detalhe.contatoNome, detalhe.waId);
  const primeiroNome = sessao?.nome.split(' ')[0] ?? 'você';

  // orçamento: o prefixo *Nome* conta quando esta resposta vai abrir a fala
  const comPrefixo = prefixoSeAplica(mensagens, sessao?.userId);
  const custoPrefixo = comPrefixo && sessao ? `*${sessao.nome}*\n\n`.length : 0;
  const restantes = detalhe.limiteResposta - custoPrefixo - texto.length;

  const podeEnviar = minhaPosse && !janelaFechada;
  const motivoBloqueio = janelaFechada
    ? 'Janela de 24h fechada · a Meta só aceita template de reengajamento'
    : t.status === 'aguardando_humano'
      ? 'Assuma a conversa para responder'
      : t.status === 'humano_ativo'
        ? `Em atendimento por ${t.atendenteNome ?? 'outro atendente'}`
        : t.status === 'resolvido'
          ? 'Conversa resolvida · reabre quando o cotista escrever'
          : 'O agente está atendendo · responda depois que a conversa escalar';

  async function agir(acao: 'assumir' | 'devolver' | 'resolver') {
    setErro(null);
    try {
      await aoAgir(acao);
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e));
    }
  }

  async function enviar(e?: React.FormEvent) {
    e?.preventDefault();
    const corpo = texto.trim();
    if (!corpo || restantes < 0 || enviando) return;
    setEnviando(true);
    setErro(null);
    try {
      await aoResponder(corpo);
      setTexto('');
    } catch (err) {
      setErro(err instanceof Error ? err.message : String(err));
    } finally {
      setEnviando(false);
    }
  }

  const rotuloStatus =
    t.status === 'humano_ativo'
      ? minhaPosse
        ? `${primeiroNome} (você)`
        : `Em atendimento · ${t.atendenteNome ?? 'atendente'}`
      : st.rotulo;

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col bg-surface-3">
      <header className="flex min-h-[60px] flex-wrap items-center gap-3 border-b border-line bg-surface px-[18px] py-2">
        <div className="min-w-[180px] flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[15px] font-semibold">{nome}</span>
            <Chip papel={st.papel}>{rotuloStatus}</Chip>
          </div>
          <div className="font-mono text-[11px] text-text-3">{telefoneBonito(detalhe.waId)}</div>
        </div>
        <div className="flex flex-wrap gap-2">
          {t.status === 'aguardando_humano' && (
            <Button onClick={() => agir('assumir')}>Assumir</Button>
          )}
          {minhaPosse && (
            <>
              <Button variant="outline" onClick={() => agir('devolver')}>
                Devolver ao agente
              </Button>
              <Button variant="outline" onClick={() => agir('resolver')}>
                Resolver
              </Button>
            </>
          )}
          <Link
            href={`/aprendizado?c=${detalhe.conversaId}`}
            className={cn(buttonVariants({ variant: 'outline' }), 'no-underline')}
          >
            Ver histórico do agente
          </Link>
          <Button variant="outline" onClick={aoAbrirContexto} className="xl:hidden">
            Contexto
          </Button>
        </div>
      </header>

      {t.status === 'aguardando_humano' && (
        <Aviso tom="warn" pulsa>
          <b>Escalado por:</b> {motivoLabel(t.motivoEscalonamento)}
          {t.esperaSegundos !== null && <> · aguardando há {duracao(t.esperaSegundos)}</>}
        </Aviso>
      )}
      {janela.estado === 'fechando' && (
        <Aviso tom="warn">
          <b>Janela de 24h</b> · {janela.rotulo}
        </Aviso>
      )}
      {janelaFechada && (
        <Aviso tom="risk">
          <b>Janela de 24h</b> · fechada — só um template de reengajamento reabre a conversa
        </Aviso>
      )}
      {erro && <Aviso tom="risk">{erro}</Aviso>}

      <Thread
        mensagens={mensagens}
        temMais={temMais}
        carregandoMais={carregandoMais}
        aoCarregarMais={aoCarregarMais}
      />

      <div className="border-t border-line bg-surface px-[18px] py-3">
        {podeEnviar ? (
          <form onSubmit={enviar} className="flex flex-col gap-1">
            <div className="flex items-end gap-2.5">
              <Textarea
                rows={2}
                value={texto}
                onChange={(e) => setTexto(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    enviar();
                  }
                }}
                placeholder={`Escreva como ${primeiroNome} · sua mensagem sai com o prefixo *${primeiroNome}*`}
                aria-label="Resposta ao cotista"
                className="flex-1"
              />
              <Button
                type="submit"
                size="md"
                disabled={enviando || !texto.trim() || restantes < 0}
                className="h-10"
              >
                Enviar
              </Button>
            </div>
            <div className="flex justify-between text-[11px] text-text-3">
              <span>
                {comPrefixo
                  ? 'seu nome abre a mensagem · Enter envia, Shift+Enter quebra linha'
                  : 'Enter envia, Shift+Enter quebra linha'}
              </span>
              <span className={cn(restantes < 0 && 'text-brand')}>
                {restantes} caracteres restantes
              </span>
            </div>
          </form>
        ) : (
          <div className="flex h-10 items-center justify-center gap-2 rounded-[10px] border border-dashed border-line-strong text-[13px] text-text-3">
            {motivoBloqueio}
            {t.status === 'aguardando_humano' && (
              <button
                type="button"
                onClick={() => agir('assumir')}
                className="font-semibold text-brand"
              >
                Assumir agora
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
