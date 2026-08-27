'use client';

import { useCallback, useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { useSessao } from '../layout';

/** Aba Aprendizado (009): fila de propostas + catálogo de skills. Papel curador. */

interface Proposta {
  id: string;
  tipo: string;
  frontmatter: {
    name: string;
    description: string;
    'x-seta': { gatilho: string; tools: string[] };
  };
  diff: string;
  impactoConversas: number;
}

interface SkillCatalogo {
  id: string;
  idLogico: string;
  ativa: {
    versao: number;
    descricao: string;
    criadoPor: string;
    aprovadoPor: string | null;
  } | null;
  usos: number;
  taxaResolucao: number;
  versoes: { versao: number; status: string; criadoPor: string }[];
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

export default function AprendizadoPage() {
  const sessao = useSessao();
  const [propostas, setPropostas] = useState<Proposta[]>([]);
  const [skills, setSkills] = useState<SkillCatalogo[]>([]);
  const [gerando, setGerando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const [editando, setEditando] = useState<{ id: string; corpo: string } | null>(null);

  const recarregar = useCallback(() => {
    fetch('/api/aprendizado/propostas')
      .then((r) => json<Proposta[]>(r))
      .then(setPropostas)
      .catch(() => {});
    fetch('/api/aprendizado/skills')
      .then((r) => json<SkillCatalogo[]>(r))
      .then(setSkills)
      .catch(() => {});
  }, []);

  useEffect(() => {
    recarregar();
  }, [recarregar]);

  if (sessao && sessao.role !== 'curador') {
    return (
      <main className="flex h-full items-center justify-center text-sm text-muted-foreground">
        A aba Aprendizado exige o papel curador.
      </main>
    );
  }

  async function gerar() {
    setGerando(true);
    setAviso(null);
    try {
      const r = await fetch('/api/aprendizado/gerar', { method: 'POST' }).then((res) =>
        json<{ clusters: number; propostasCriadas: number; sinaisProcessados: number }>(res),
      );
      setAviso(
        `${r.sinaisProcessados} sinais → ${r.clusters} clusters → ${r.propostasCriadas} proposta(s).`,
      );
      recarregar();
    } catch (e) {
      setAviso(e instanceof Error ? e.message : String(e));
    } finally {
      setGerando(false);
    }
  }

  async function agir(url: string, body?: unknown) {
    setAviso(null);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      if (!res.ok) throw new Error(await res.text());
      setEditando(null);
      recarregar();
    } catch (e) {
      setAviso(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <main className="h-full space-y-8 overflow-y-auto p-4">
      <section className="space-y-3">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold">Propostas do distiller</h2>
          <span className="rounded-full bg-muted px-2 text-xs">{propostas.length}</span>
          <button
            type="button"
            onClick={gerar}
            disabled={gerando}
            className="ml-auto rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            {gerando ? 'Gerando…' : '⚙ Gerar propostas'}
          </button>
        </div>
        {aviso && <p className="text-xs text-muted-foreground">{aviso}</p>}
        {propostas.length === 0 && (
          <p className="text-xs text-muted-foreground">
            Fila vazia — gere propostas a partir dos sinais de produção.
          </p>
        )}
        <div className="grid gap-3 lg:grid-cols-2">
          {propostas.map((p) => (
            <article key={p.id} className="space-y-2 rounded-lg border p-3 text-sm">
              <header className="flex items-center gap-2">
                <span className="font-medium">{p.frontmatter.name}</span>
                <span className="rounded-full bg-muted px-2 text-[10px]">{p.tipo}</span>
                <span className="ml-auto text-[10px] text-muted-foreground">
                  impacto: {p.impactoConversas} conversa(s)
                </span>
              </header>
              <p className="text-xs text-muted-foreground">{p.frontmatter.description}</p>
              <p className="text-xs">
                <span className="text-muted-foreground">gatilho:</span>{' '}
                {p.frontmatter['x-seta'].gatilho}
              </p>
              {editando?.id === p.id ? (
                <textarea
                  className="h-40 w-full rounded-md border bg-transparent p-2 font-mono text-xs"
                  value={editando.corpo}
                  onChange={(e) => setEditando({ id: p.id, corpo: e.target.value })}
                />
              ) : (
                <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md bg-muted/50 p-2 font-mono text-xs">
                  {p.diff}
                </pre>
              )}
              <footer className="flex gap-2">
                <button
                  type="button"
                  onClick={() =>
                    agir(
                      `/api/aprendizado/proposta/${p.id}/aprovar`,
                      editando?.id === p.id ? { corpo: editando.corpo } : {},
                    )
                  }
                  className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground"
                >
                  {editando?.id === p.id ? 'Aprovar edição' : 'Aprovar'}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setEditando(editando?.id === p.id ? null : { id: p.id, corpo: p.diff })
                  }
                  className="rounded-md border px-3 py-1 text-xs"
                >
                  {editando?.id === p.id ? 'Cancelar edição' : 'Editar'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const motivo = window.prompt('Motivo da rejeição:');
                    if (motivo) agir(`/api/aprendizado/proposta/${p.id}/rejeitar`, { motivo });
                  }}
                  className="ml-auto rounded-md border border-red-500/50 px-3 py-1 text-xs text-red-600"
                >
                  Rejeitar
                </button>
              </footer>
            </article>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Catálogo de skills</h2>
        <div className="grid gap-3 lg:grid-cols-2">
          {skills.map((s) => (
            <article key={s.id} className="space-y-2 rounded-lg border p-3 text-sm">
              <header className="flex items-center gap-2">
                <span className="font-medium">{s.idLogico}</span>
                <span
                  className={cn(
                    'rounded-full px-2 text-[10px]',
                    s.ativa ? 'bg-green-500/15 text-green-600' : 'bg-red-500/15 text-red-600',
                  )}
                >
                  {s.ativa ? `v${s.ativa.versao} ativa` : 'desativado'}
                </span>
                <span className="ml-auto text-[10px] text-muted-foreground">
                  {s.usos} usos · {(s.taxaResolucao * 100).toFixed(0)}% resolução
                </span>
              </header>
              {s.ativa && <p className="text-xs text-muted-foreground">{s.ativa.descricao}</p>}
              <p className="text-[10px] text-muted-foreground">
                versões: {s.versoes.map((v) => `v${v.versao}(${v.status})`).join(' · ')}
              </p>
              <footer className="flex gap-2">
                {s.versoes
                  .filter((v) => v.status === 'arquivada')
                  .slice(0, 1)
                  .map((v) => (
                    <button
                      key={v.versao}
                      type="button"
                      onClick={() =>
                        agir(`/api/aprendizado/skill/${s.id}/rollback`, {
                          paraVersao: v.versao,
                          motivo: 'rollback pelo console',
                        })
                      }
                      className="rounded-md border px-3 py-1 text-xs"
                    >
                      ↩ Rollback p/ v{v.versao}
                    </button>
                  ))}
                {s.ativa && (
                  <button
                    type="button"
                    onClick={() => {
                      const motivo = window.prompt('Motivo do kill-switch:');
                      if (motivo) agir(`/api/aprendizado/skill/${s.id}/desativar`, { motivo });
                    }}
                    className="ml-auto rounded-md border border-red-500/50 px-3 py-1 text-xs text-red-600"
                  >
                    ⛔ Kill-switch
                  </button>
                )}
              </footer>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
