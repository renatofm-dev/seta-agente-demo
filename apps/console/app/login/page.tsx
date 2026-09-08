'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Campo, Input } from '@/components/ui/input';
import { api } from '@/lib/console-api';

/** Login em duas metades (design): painel escuro com a proposta, formulário à direita. */
export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState(
    process.env.NODE_ENV === 'production' ? '' : 'atendente@demo.seta',
  );
  const [senha, setSenha] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [instalacao, setInstalacao] = useState<string | null>(null);

  useEffect(() => {
    api.instalacaoPublica().then((i) => setInstalacao(i?.nome ?? null));
  }, []);

  async function entrar(e: React.FormEvent) {
    e.preventDefault();
    setEnviando(true);
    setErro(null);
    const res = await api.login(email, senha);
    setEnviando(false);
    if (!res.ok) {
      setErro('Credenciais inválidas.');
      return;
    }
    router.push('/inbox');
  }

  return (
    <main className="grid min-h-dvh grid-cols-1 lg:grid-cols-2">
      <section className="flex flex-col justify-between bg-ink p-8 text-white lg:p-12">
        <div className="flex items-center gap-2.5">
          <span className="size-7 rounded-[8px] bg-linear-to-br from-brand to-laranja" />
          <span className="font-heading text-lg font-bold tracking-[-.02em]">
            SETA<span className="text-brand-soft">.</span>IA
          </span>
        </div>
        <div className="my-10 max-w-md">
          <div className="mb-4 font-mono text-[11px] uppercase tracking-[.12em] text-brand-soft">
            Console de operação
          </div>
          <h1 className="m-0 mb-4 font-heading text-[34px] font-semibold leading-[1.1] tracking-[-.03em] lg:text-[40px]">
            Atendimento e campanhas de cobrança no WhatsApp.
          </h1>
          <p className="m-0 text-base text-[#b5b3b8]">
            O agente resolve o simples. A fila mostra só o que precisa de gente.
          </p>
        </div>
        <div className="font-mono text-[11px] text-[#87868f]">
          {instalacao ? `${instalacao} · ` : ''}piloto
        </div>
      </section>
      <section className="flex items-center justify-center p-8 lg:p-12">
        <form onSubmit={entrar} className="flex w-full max-w-[380px] flex-col gap-5">
          <div>
            <h2 className="m-0 mb-1.5 font-heading text-[26px] font-semibold tracking-[-.02em]">
              Entrar
            </h2>
            <p className="m-0 text-text-3">Use as credenciais da sua operação.</p>
          </div>
          <Campo rotulo="E-mail">
            <Input
              type="email"
              required
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="h-11"
            />
          </Campo>
          <Campo rotulo="Senha">
            <Input
              type="password"
              required
              autoComplete="current-password"
              value={senha}
              onChange={(e) => setSenha(e.target.value)}
              className="h-11"
            />
          </Campo>
          {erro && <p className="m-0 text-sm text-brand">{erro}</p>}
          <Button type="submit" size="lg" disabled={enviando} className="w-full text-[15px]">
            {enviando ? 'Entrando…' : 'Entrar no console'}
          </Button>
        </form>
      </section>
    </main>
  );
}
