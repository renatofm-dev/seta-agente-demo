'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, Vazio } from '@/components/ui/card';
import { Chip } from '@/components/ui/chip';
import { Textarea } from '@/components/ui/input';
import { ModalMotivo } from '@/components/ui/modal-motivo';
import { Pagina } from '@/components/ui/page-header';

/**
 * Curadoria (009, papel curador): fila de propostas do distiller + catálogo de
 * skills com rollback e kill-switch. Motivos agora passam pelo modal (sem
 * window.prompt).
 */

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

type Modal =
  | { tipo: 'rejeitar'; propostaId: string; nome: string }
  | { tipo: 'desativar'; skillId: string; nome: string }
  | null;

export function Curadoria() {
  const [propostas, setPropostas] = useState<Proposta[]>([]);
  const [skills, setSkills] = useState<SkillCatalogo[]>([]);
  const [gerando, setGerando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const [editando, setEditando] = useState<{ id: string; corpo: string } | null>(null);
  const [modal, setModal] = useState<Modal>(null);

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
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    if (!res.ok) throw new Error(await res.text());
    setEditando(null);
    recarregar();
  }

  const agirComAviso = (url: string, body?: unknown) =>
    agir(url, body).catch((e) => setAviso(e instanceof Error ? e.message : String(e)));

  return (
    <Pagina className="gap-7">
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="m-0 font-heading text-lg font-semibold tracking-[-.02em]">
            Propostas do distiller
          </h2>
          <Chip papel="off">{propostas.length}</Chip>
          <Button variant="ink" onClick={gerar} disabled={gerando} className="ml-auto">
            {gerando ? 'Gerando…' : 'Gerar propostas'}
          </Button>
        </div>
        {aviso && <p className="m-0 text-xs text-text-2">{aviso}</p>}
        {propostas.length === 0 && (
          <Vazio texto="Fila vazia — as propostas nascem dos sinais de produção (correções do atendente, feedback dos turnos, escalonamentos). Gere quando houver sinais novos." />
        )}
        <div className="grid gap-3 lg:grid-cols-2">
          {propostas.map((p) => (
            <Card key={p.id} className="flex flex-col gap-2 p-4 text-[13px]">
              <header className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs font-medium">{p.frontmatter.name}</span>
                <Chip papel="info">{p.tipo}</Chip>
                <span className="ml-auto font-mono text-[10.5px] text-text-3">
                  impacto: {p.impactoConversas} conversa(s)
                </span>
              </header>
              <p className="m-0 text-text-2">{p.frontmatter.description}</p>
              <p className="m-0 text-xs">
                <span className="text-text-3">gatilho:</span> {p.frontmatter['x-seta'].gatilho}
              </p>
              {editando?.id === p.id ? (
                <Textarea
                  className="h-44 font-mono text-xs"
                  value={editando.corpo}
                  onChange={(e) => setEditando({ id: p.id, corpo: e.target.value })}
                />
              ) : (
                <pre className="m-0 max-h-44 overflow-y-auto whitespace-pre-wrap rounded-[8px] bg-surface-2 p-2.5 font-mono text-xs">
                  {p.diff}
                </pre>
              )}
              <footer className="flex flex-wrap gap-2">
                <Button
                  variant="success"
                  size="sm"
                  onClick={() =>
                    agirComAviso(
                      `/api/aprendizado/proposta/${p.id}/aprovar`,
                      editando?.id === p.id ? { corpo: editando.corpo } : {},
                    )
                  }
                >
                  {editando?.id === p.id ? 'Aprovar edição' : 'Aprovar'}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setEditando(editando?.id === p.id ? null : { id: p.id, corpo: p.diff })
                  }
                >
                  {editando?.id === p.id ? 'Cancelar edição' : 'Editar'}
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  className="ml-auto"
                  onClick={() =>
                    setModal({ tipo: 'rejeitar', propostaId: p.id, nome: p.frontmatter.name })
                  }
                >
                  Rejeitar
                </Button>
              </footer>
            </Card>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="m-0 font-heading text-lg font-semibold tracking-[-.02em]">
          Catálogo de skills
        </h2>
        {skills.length === 0 && <Vazio texto="Nenhuma skill no catálogo ainda." />}
        <div className="grid gap-3 lg:grid-cols-2">
          {skills.map((s) => (
            <Card key={s.id} className="flex flex-col gap-2 p-4 text-[13px]">
              <header className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs font-medium">{s.idLogico}</span>
                <Chip papel={s.ativa ? 'ok' : 'risk'}>
                  {s.ativa ? `v${s.ativa.versao} ativa` : 'desativada'}
                </Chip>
                <span className="ml-auto font-mono text-[10.5px] text-text-3">
                  {s.usos} usos · {(s.taxaResolucao * 100).toFixed(0)}% resolução
                </span>
              </header>
              {s.ativa && <p className="m-0 text-text-2">{s.ativa.descricao}</p>}
              <p className="m-0 font-mono text-[10.5px] text-text-3">
                versões: {s.versoes.map((v) => `v${v.versao} (${v.status})`).join(' · ')}
              </p>
              <footer className="flex flex-wrap gap-2">
                {s.versoes
                  .filter((v) => v.status === 'arquivada')
                  .slice(0, 1)
                  .map((v) => (
                    <Button
                      key={v.versao}
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        agirComAviso(`/api/aprendizado/skill/${s.id}/rollback`, {
                          paraVersao: v.versao,
                          motivo: 'rollback pelo console',
                        })
                      }
                    >
                      ↩ Rollback p/ v{v.versao}
                    </Button>
                  ))}
                {s.ativa && (
                  <Button
                    variant="danger"
                    size="sm"
                    className="ml-auto"
                    onClick={() => setModal({ tipo: 'desativar', skillId: s.id, nome: s.idLogico })}
                  >
                    ⛔ Kill-switch
                  </Button>
                )}
              </footer>
            </Card>
          ))}
        </div>
      </section>

      <ModalMotivo
        aberto={modal?.tipo === 'rejeitar'}
        titulo={`Rejeitar proposta ${modal?.tipo === 'rejeitar' ? modal.nome : ''}`}
        descricao="A rejeição vira sinal de curadoria e não volta ao clustering do distiller."
        rotuloConfirmar="Rejeitar"
        aoFechar={() => setModal(null)}
        aoConfirmar={(motivo) =>
          modal?.tipo === 'rejeitar'
            ? agir(`/api/aprendizado/proposta/${modal.propostaId}/rejeitar`, { motivo })
            : undefined
        }
      />
      <ModalMotivo
        aberto={modal?.tipo === 'desativar'}
        titulo={`Desativar skill ${modal?.tipo === 'desativar' ? modal.nome : ''}`}
        descricao="Kill-switch: o agente deixa de usar a skill imediatamente. O motivo fica na auditoria."
        rotuloConfirmar="Desativar"
        aoFechar={() => setModal(null)}
        aoConfirmar={(motivo) =>
          modal?.tipo === 'desativar'
            ? agir(`/api/aprendizado/skill/${modal.skillId}/desativar`, { motivo })
            : undefined
        }
      />
    </Pagina>
  );
}
