'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Ponto } from '@/components/ui/chip';
import { api, type Instalacao, type Resumo, type Sessao } from '@/lib/console-api';
import { iniciais } from '@/lib/formatos';
import { cn } from '@/lib/utils';

/**
 * Casca do console (design Console SETA.dc.html): barra de 56px com marca,
 * nav por módulo com badges do que espera gente, indicador ao vivo e menu do
 * usuário. Guarda de rota: sem sessão Better Auth → /login.
 */

const SessaoContext = createContext<Sessao | null>(null);
export const useSessao = () => useContext(SessaoContext);

const InstalacaoContext = createContext<Instalacao | null>(null);
export const useInstalacao = () => useContext(InstalacaoContext);

const ResumoContext = createContext<{ resumo: Resumo | null; recarregar: () => void }>({
  resumo: null,
  recarregar: () => {},
});
export const useResumo = () => useContext(ResumoContext);

interface ItemNav {
  href: string;
  rotulo: string;
  badge?: (r: Resumo) => number;
  modulo?: keyof Instalacao['modulos'];
  /** rotas antigas que contam como este item (ativo no nav) */
  tambem?: string[];
}

const NAV: ItemNav[] = [
  { href: '/inbox', rotulo: 'Atendimento', badge: (r) => r.aguardandoHumano, tambem: ['/ticket'] },
  { href: '/campanhas', rotulo: 'Campanhas', tambem: ['/disparos'] },
  {
    href: '/cobrancas',
    rotulo: 'Cobranças',
    badge: (r) => r.cobrancasAguardandoAprovacao,
    modulo: 'pagamentos',
  },
  { href: '/leads', rotulo: 'Leads', badge: (r) => r.leadsAguardandoAprovacao, modulo: 'sdr' },
  { href: '/aprendizado', rotulo: 'Aprendizado' },
  { href: '/metricas', rotulo: 'Métricas' },
  { href: '/config', rotulo: 'Configurações' },
];

function MenuUsuario({ sessao, aoSair }: { sessao: Sessao; aoSair: () => void }) {
  const [aberto, setAberto] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!aberto) return;
    const fora = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setAberto(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAberto(false);
    };
    window.addEventListener('mousedown', fora);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('mousedown', fora);
      window.removeEventListener('keydown', esc);
    };
  }, [aberto]);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setAberto((v) => !v)}
        title={`${sessao.nome} · ${sessao.role}`}
        aria-haspopup="menu"
        aria-expanded={aberto}
        className="flex size-[34px] items-center justify-center rounded-full bg-ink font-heading text-xs font-semibold text-white"
      >
        {iniciais(sessao.nome)}
      </button>
      {aberto && (
        <div
          role="menu"
          className="absolute right-0 top-11 z-30 w-56 rounded-[12px] border border-line bg-surface p-1.5 shadow-[0_12px_32px_rgba(20,20,26,.12)]"
        >
          <div className="px-2.5 py-2">
            <div className="truncate text-[13px] font-semibold">{sessao.nome}</div>
            <div className="truncate text-xs text-text-3">
              {sessao.email} · {sessao.role}
            </div>
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={aoSair}
            className="w-full rounded-[8px] px-2.5 py-2 text-left text-[13px] font-semibold text-text-2 hover:bg-surface-3 hover:text-ink"
          >
            Sair
          </button>
        </div>
      )}
    </div>
  );
}

export default function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [sessao, setSessao] = useState<Sessao | null>(null);
  const [instalacao, setInstalacao] = useState<Instalacao | null>(null);
  const [resumo, setResumo] = useState<Resumo | null>(null);
  const [aoVivo, setAoVivo] = useState<boolean | null>(null);
  const [carregando, setCarregando] = useState(true);

  useEffect(() => {
    api.me().then((s) => {
      if (!s) {
        router.replace('/login');
        return;
      }
      setSessao(s);
      setCarregando(false);
    });
  }, [router]);

  const recarregarResumo = useCallback(() => {
    api
      .resumo()
      .then(setResumo)
      .catch(() => {});
  }, []);

  // instalação + badges; SSE de tickets atualiza o badge da fila (< 3 s) e
  // mostra se o console está ao vivo ou caiu para polling
  useEffect(() => {
    if (!sessao) return;
    api
      .instalacao()
      .then(setInstalacao)
      .catch(() => {});
    recarregarResumo();
    const timer = setInterval(recarregarResumo, 30_000);
    const es = new EventSource('/api/console/events');
    let agendado: ReturnType<typeof setTimeout> | null = null;
    es.onopen = () => setAoVivo(true);
    es.onerror = () => setAoVivo(false);
    es.addEventListener('ticket', () => {
      if (agendado) return;
      agendado = setTimeout(() => {
        agendado = null;
        recarregarResumo();
      }, 500);
    });
    return () => {
      clearInterval(timer);
      es.close();
      if (agendado) clearTimeout(agendado);
    };
  }, [sessao, recarregarResumo]);

  if (carregando || !sessao) {
    return (
      <main className="flex flex-1 items-center justify-center text-sm text-text-3">
        Carregando…
      </main>
    );
  }

  const itens = NAV.filter((n) => !n.modulo || !instalacao || instalacao.modulos[n.modulo]);
  const ativo = (n: ItemNav) =>
    pathname.startsWith(n.href) || (n.tambem ?? []).some((p) => pathname.startsWith(p));

  const avisos: string[] = [];
  if (instalacao?.canal.gateway === 'log-only') {
    avisos.push('WhatsApp em modo teste: mensagens só no log do servidor.');
  }
  if (instalacao?.modulos.pagamentos && instalacao.psp?.nome === 'simulado') {
    avisos.push('PSP simulado: links e códigos de pagamento são fictícios.');
  }

  return (
    <SessaoContext.Provider value={sessao}>
      <InstalacaoContext.Provider value={instalacao}>
        <ResumoContext.Provider value={{ resumo, recarregar: recarregarResumo }}>
          <div className="flex h-dvh flex-col">
            <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-3.5 border-b border-line bg-surface px-4 print:hidden">
              <Link href="/inbox" className="flex flex-none items-center gap-2.5 no-underline">
                <span className="size-6 rounded-[7px] bg-linear-to-br from-brand to-laranja" />
                <span className="font-heading text-base font-bold tracking-[-.02em] text-ink">
                  SETA<span className="text-brand">.</span>IA
                </span>
              </Link>
              <nav
                className="flex h-14 min-w-0 flex-1 gap-0 overflow-x-auto"
                aria-label="Principal"
              >
                {itens.map((n) => {
                  const on = ativo(n);
                  const badge = resumo && n.badge ? n.badge(resumo) : 0;
                  return (
                    <Link
                      key={n.href}
                      href={n.href}
                      className={cn(
                        'flex items-center gap-1 whitespace-nowrap border-b-2 px-1.5 text-xs font-semibold no-underline transition-colors',
                        on
                          ? 'border-brand text-ink'
                          : 'border-transparent text-text-3 hover:text-ink',
                      )}
                    >
                      {n.rotulo}
                      {badge > 0 && (
                        <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-brand px-1.5 font-mono text-[10.5px] text-white">
                          {badge}
                        </span>
                      )}
                    </Link>
                  );
                })}
              </nav>
              <div className="flex flex-none items-center gap-3">
                <div
                  className="flex h-[34px] items-center gap-2 rounded-[9px] border border-line bg-background px-3 text-[13px] font-medium text-text-2"
                  title={
                    aoVivo === false
                      ? 'Conexão de eventos caiu — atualizando por polling'
                      : 'Ao vivo: eventos do servidor chegam em tempo real'
                  }
                >
                  <Ponto tom={aoVivo === false ? 'risk' : aoVivo ? 'ok' : 'off'} />
                  <span className="max-w-[220px] truncate font-heading font-semibold">
                    {instalacao?.nome ?? '…'}
                  </span>
                </div>
                <MenuUsuario
                  sessao={sessao}
                  aoSair={async () => {
                    await api.logout();
                    router.replace('/login');
                  }}
                />
              </div>
            </header>
            {avisos.length > 0 && (
              <div className="flex shrink-0 flex-wrap gap-x-6 gap-y-1 border-b border-warn-2/35 bg-warn-2/14 px-4 py-1.5 text-xs text-warn print:hidden">
                {avisos.map((a) => (
                  <span key={a}>{a}</span>
                ))}
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
          </div>
        </ResumoContext.Provider>
      </InstalacaoContext.Provider>
    </SessaoContext.Provider>
  );
}
