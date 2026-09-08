'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, useState } from 'react';
import { api, type Sessao } from '@/lib/console-api';

/** Guarda de rota do console: sem sessão Better Auth → /login. */

const SessaoContext = createContext<Sessao | null>(null);
export const useSessao = () => useContext(SessaoContext);

export default function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [sessao, setSessao] = useState<Sessao | null>(null);
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

  if (carregando || !sessao) {
    return <main className="flex flex-1 items-center justify-center text-sm">Carregando…</main>;
  }

  return (
    <SessaoContext.Provider value={sessao}>
      <div className="flex h-dvh flex-col">
        <header className="flex items-center gap-4 border-b px-4 py-2">
          <span className="font-semibold">SETA Console</span>
          <nav className="flex gap-3 text-sm">
            <Link
              href="/inbox"
              className={pathname === '/inbox' ? 'font-medium' : 'text-muted-foreground'}
            >
              Inbox
            </Link>
            {sessao.role === 'curador' && (
              <Link
                href="/aprendizado"
                className={pathname === '/aprendizado' ? 'font-medium' : 'text-muted-foreground'}
              >
                Aprendizado
              </Link>
            )}
            <Link
              href="/disparos"
              className={pathname === '/disparos' ? 'font-medium' : 'text-muted-foreground'}
            >
              Disparos
            </Link>
            <Link
              href="/cobrancas"
              className={pathname === '/cobrancas' ? 'font-medium' : 'text-muted-foreground'}
            >
              Cobranças
            </Link>
            <Link
              href="/metricas"
              className={pathname === '/metricas' ? 'font-medium' : 'text-muted-foreground'}
            >
              Métricas
            </Link>
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm">
            <span className="text-muted-foreground">
              {sessao.nome} · {sessao.role}
            </span>
            <button
              type="button"
              className="rounded-md border px-2 py-1 text-xs"
              onClick={async () => {
                await api.logout();
                router.replace('/login');
              }}
            >
              Sair
            </button>
          </div>
        </header>
        <div className="flex-1 overflow-hidden">{children}</div>
      </div>
    </SessaoContext.Provider>
  );
}
