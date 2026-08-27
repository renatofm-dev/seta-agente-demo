'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/console-api';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('atendente@demo.seta');
  const [senha, setSenha] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

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
    <main className="flex flex-1 items-center justify-center p-4">
      <form onSubmit={entrar} className="w-full max-w-sm space-y-4 rounded-xl border p-6">
        <div>
          <h1 className="text-lg font-semibold">SETA Console</h1>
          <p className="text-sm text-muted-foreground">Atendimento humano + curadoria</p>
        </div>
        <label className="block space-y-1 text-sm">
          <span>E-mail</span>
          <input
            type="email"
            required
            className="w-full rounded-md border bg-transparent px-3 py-2"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className="block space-y-1 text-sm">
          <span>Senha</span>
          <input
            type="password"
            required
            className="w-full rounded-md border bg-transparent px-3 py-2"
            value={senha}
            onChange={(e) => setSenha(e.target.value)}
          />
        </label>
        {erro && <p className="text-sm text-red-600">{erro}</p>}
        <button
          type="submit"
          disabled={enviando}
          className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {enviando ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
    </main>
  );
}
