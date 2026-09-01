'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  api,
  type ContatoCarteira,
  type DisparoDestinatarioView,
  type DisparoResumo,
  type Modelo,
} from '@/lib/console-api';
import { telefoneBonito } from '@/lib/formatos';
import { cn } from '@/lib/utils';

/**
 * Disparos (013): modelos de mensagem criados da plataforma (registrados na
 * Meta, com status de aprovação) e disparos de template para a carteira.
 */

const CHIP_MODELO: Record<Modelo['statusMeta'], string> = {
  aprovado: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  pendente: 'bg-amber-500/20 text-amber-700 dark:text-amber-400',
  rejeitado: 'bg-red-500/15 text-red-600',
  desconhecido: 'bg-muted text-muted-foreground',
};

/** Variáveis {{1}}..{{N}} do corpo (espelho client-side do wa-meta). */
function variaveisDoCorpo(corpo: string): number[] {
  const ns = [...corpo.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
  return [...new Set(ns)].sort((a, b) => a - b);
}

function FormNovoModelo({ aoCriar }: { aoCriar: () => void }) {
  const [nome, setNome] = useState('');
  const [categoria, setCategoria] = useState<'utility' | 'marketing'>('utility');
  const [corpo, setCorpo] = useState('');
  const [rodape, setRodape] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);

  async function criar(e: React.FormEvent) {
    e.preventDefault();
    setErro(null);
    setSalvando(true);
    try {
      await api.criarModelo({
        nome: nome.trim(),
        categoria,
        corpo: corpo.trim(),
        ...(rodape.trim() ? { rodape: rodape.trim() } : {}),
      });
      setNome('');
      setCorpo('');
      setRodape('');
      aoCriar();
    } catch (err) {
      setErro(err instanceof Error ? err.message : String(err));
    } finally {
      setSalvando(false);
    }
  }

  return (
    <form onSubmit={criar} className="space-y-2 rounded-lg border p-3">
      <p className="text-sm font-medium">Novo modelo</p>
      <div className="flex gap-2">
        <input
          value={nome}
          onChange={(e) => setNome(e.target.value)}
          placeholder="nome_do_modelo (minúsculas e _)"
          className="flex-1 rounded-md border bg-transparent px-3 py-1.5 text-sm"
        />
        <select
          value={categoria}
          onChange={(e) => setCategoria(e.target.value as 'utility' | 'marketing')}
          className="rounded-md border bg-transparent px-2 py-1.5 text-sm"
        >
          <option value="utility">utility</option>
          <option value="marketing">marketing</option>
        </select>
      </div>
      <textarea
        value={corpo}
        onChange={(e) => setCorpo(e.target.value)}
        placeholder={'Corpo da mensagem. Use {{1}}, {{2}}… para variáveis.'}
        rows={3}
        className="w-full rounded-md border bg-transparent px-3 py-1.5 text-sm"
      />
      <div className="flex items-center gap-2">
        <input
          value={rodape}
          onChange={(e) => setRodape(e.target.value)}
          placeholder="Rodapé (opcional)"
          className="flex-1 rounded-md border bg-transparent px-3 py-1.5 text-sm"
        />
        <button
          type="submit"
          disabled={salvando || !nome.trim() || !corpo.trim()}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {salvando ? 'Registrando na Meta…' : 'Criar e enviar p/ aprovação'}
        </button>
      </div>
      {corpo && (
        <p className="text-[11px] text-muted-foreground">
          {variaveisDoCorpo(corpo).length} variável(is) detectada(s)
        </p>
      )}
      {erro && <p className="text-xs text-red-600">{erro}</p>}
    </form>
  );
}

function FormNovoDisparo({
  modelos,
  carteira,
  aoDisparar,
}: {
  modelos: Modelo[];
  carteira: ContatoCarteira[];
  aoDisparar: () => void;
}) {
  const aprovados = useMemo(() => modelos.filter((m) => m.statusMeta === 'aprovado'), [modelos]);
  const [modeloId, setModeloId] = useState('');
  const [valores, setValores] = useState<string[]>([]);
  const [selecionados, setSelecionados] = useState<Set<string>>(new Set());
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  const modelo = aprovados.find((m) => m.id === modeloId) ?? null;
  const nVars = modelo ? variaveisDoCorpo(modelo.corpo).length : 0;

  function alternar(waId: string) {
    setSelecionados((s) => {
      const novo = new Set(s);
      if (novo.has(waId)) novo.delete(waId);
      else novo.add(waId);
      return novo;
    });
  }

  async function disparar(e: React.FormEvent) {
    e.preventDefault();
    if (!modelo) return;
    setErro(null);
    setEnviando(true);
    try {
      await api.criarDisparo({
        modeloId: modelo.id,
        variaveis: valores.slice(0, nVars).map((v) => v.trim()),
        waIds: [...selecionados],
      });
      setSelecionados(new Set());
      setValores([]);
      setModeloId('');
      aoDisparar();
    } catch (err) {
      setErro(err instanceof Error ? err.message : String(err));
    } finally {
      setEnviando(false);
    }
  }

  if (aprovados.length === 0) {
    return (
      <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
        Nenhum modelo aprovado ainda — crie um modelo e sincronize quando a Meta aprovar.
      </p>
    );
  }

  return (
    <form onSubmit={disparar} className="space-y-2 rounded-lg border p-3">
      <p className="text-sm font-medium">Novo disparo</p>
      <select
        value={modeloId}
        onChange={(e) => {
          setModeloId(e.target.value);
          setValores([]);
        }}
        className="w-full rounded-md border bg-transparent px-2 py-1.5 text-sm"
      >
        <option value="">Escolha um modelo aprovado…</option>
        {aprovados.map((m) => (
          <option key={m.id} value={m.id}>
            {m.nome} ({m.idioma})
          </option>
        ))}
      </select>
      {modelo && (
        <p className="whitespace-pre-wrap rounded bg-muted/50 p-2 text-xs">{modelo.corpo}</p>
      )}
      {modelo &&
        Array.from({ length: nVars }, (_, i) => (
          <input
            // biome-ignore lint/suspicious/noArrayIndexKey: posição É a identidade ({{i+1}})
            key={i}
            value={valores[i] ?? ''}
            onChange={(e) =>
              setValores((v) => {
                const novo = [...v];
                novo[i] = e.target.value;
                return novo;
              })
            }
            placeholder={`Valor de {{${i + 1}}}`}
            className="w-full rounded-md border bg-transparent px-3 py-1.5 text-sm"
          />
        ))}
      {modelo && (
        <div className="max-h-40 space-y-1 overflow-y-auto rounded border p-2">
          <label className="flex items-center gap-2 text-xs font-medium">
            <input
              type="checkbox"
              checked={selecionados.size === carteira.length && carteira.length > 0}
              onChange={(e) =>
                setSelecionados(e.target.checked ? new Set(carteira.map((c) => c.waId)) : new Set())
              }
            />
            Carteira inteira ({carteira.length})
          </label>
          {carteira.map((c) => (
            <label key={c.waId} className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={selecionados.has(c.waId)}
                onChange={() => alternar(c.waId)}
              />
              {c.nome ?? telefoneBonito(c.waId)}
              <span className="text-muted-foreground">{telefoneBonito(c.waId)}</span>
            </label>
          ))}
        </div>
      )}
      <button
        type="submit"
        disabled={
          enviando ||
          !modelo ||
          selecionados.size === 0 ||
          valores.slice(0, nVars).filter((v) => v?.trim()).length !== nVars
        }
        className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
      >
        {enviando ? 'Enfileirando…' : `Disparar para ${selecionados.size} contato(s)`}
      </button>
      {erro && <p className="text-xs text-red-600">{erro}</p>}
    </form>
  );
}

function LinhaDisparo({ d }: { d: DisparoResumo }) {
  const [aberto, setAberto] = useState(false);
  const [destinatarios, setDestinatarios] = useState<DisparoDestinatarioView[] | null>(null);

  async function alternar() {
    const vai = !aberto;
    setAberto(vai);
    if (vai && !destinatarios) {
      const r = await api.disparo(d.id).catch(() => null);
      setDestinatarios(r?.destinatarios ?? []);
    }
  }

  return (
    <div className="rounded-lg border p-3 text-sm">
      <button type="button" onClick={alternar} className="flex w-full items-center gap-2 text-left">
        <span className="font-medium">{d.modelo_nome}</span>
        <span className="rounded-full bg-muted px-2 py-0.5 text-[10px]">{d.status}</span>
        <span className="ml-auto text-xs text-muted-foreground">
          {d.total} destinatário(s) · {d.entregues + d.lidos} entregue(s) · {d.lidos} lido(s)
          {d.falhas > 0 && <span className="text-red-600"> · {d.falhas} falha(s)</span>}
        </span>
      </button>
      {aberto && (
        <ul className="mt-2 space-y-1 border-t pt-2 text-xs">
          {(destinatarios ?? []).map((dest) => (
            <li key={dest.id} className="flex items-center gap-2">
              <span>{dest.contatoNome ?? telefoneBonito(dest.waId)}</span>
              <span
                className={cn(
                  'rounded-full px-1.5 py-0.5 text-[10px]',
                  dest.status === 'falha'
                    ? 'bg-red-500/15 text-red-600'
                    : dest.status === 'lido'
                      ? 'bg-sky-500/15 text-sky-600'
                      : 'bg-muted text-muted-foreground',
                )}
              >
                {dest.status}
              </span>
              {dest.erro && <span className="truncate text-red-600">{dest.erro}</span>}
            </li>
          ))}
          {destinatarios === null && <li className="text-muted-foreground">Carregando…</li>}
        </ul>
      )}
    </div>
  );
}

export default function DisparosPage() {
  const [modelos, setModelos] = useState<Modelo[]>([]);
  const [metaConfigurada, setMetaConfigurada] = useState(true);
  const [carteira, setCarteira] = useState<ContatoCarteira[]>([]);
  const [disparos, setDisparos] = useState<DisparoResumo[]>([]);
  const [aviso, setAviso] = useState<string | null>(null);

  const recarregar = useCallback(() => {
    api
      .modelos()
      .then((r) => {
        setModelos(r.modelos);
        setMetaConfigurada(r.metaConfigurada);
      })
      .catch(() => {});
    api
      .carteira()
      .then((r) => setCarteira(r.contatos))
      .catch(() => {});
    api
      .disparos()
      .then((r) => setDisparos(r.disparos))
      .catch(() => {});
  }, []);

  useEffect(() => {
    recarregar();
    const timer = setInterval(recarregar, 5_000); // progresso dos envios
    return () => clearInterval(timer);
  }, [recarregar]);

  async function sincronizar() {
    setAviso(null);
    try {
      const r = await api.sincronizarModelos();
      setModelos(r.modelos);
      setAviso(`${r.atualizados} modelo(s) atualizado(s) pela Meta.`);
    } catch (err) {
      setAviso(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <main className="grid h-full grid-cols-1 gap-4 overflow-y-auto p-4 lg:grid-cols-2">
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">Modelos de mensagem</h2>
          <button
            type="button"
            onClick={sincronizar}
            disabled={!metaConfigurada}
            className="ml-auto rounded-md border px-2 py-1 text-xs disabled:opacity-50"
          >
            Sincronizar com a Meta
          </button>
        </div>
        {!metaConfigurada && (
          <p className="rounded-lg border border-amber-500/60 p-2 text-xs text-amber-700">
            Gestão de modelos indisponível — configure WA_WABA_ID e WA_ACCESS_TOKEN no server.
          </p>
        )}
        {aviso && <p className="text-xs text-muted-foreground">{aviso}</p>}
        {metaConfigurada && <FormNovoModelo aoCriar={recarregar} />}
        <div className="space-y-2">
          {modelos.map((m) => (
            <div key={m.id} className="rounded-lg border p-3 text-sm">
              <div className="flex items-center gap-2">
                <span className="font-medium">{m.nome}</span>
                <span className="text-[10px] text-muted-foreground">
                  {m.categoria} · {m.idioma}
                </span>
                <span
                  className={cn(
                    'ml-auto rounded-full px-2 py-0.5 text-[10px] font-medium',
                    CHIP_MODELO[m.statusMeta],
                  )}
                >
                  {m.statusMeta}
                </span>
              </div>
              <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{m.corpo}</p>
              {m.motivoRejeicao && (
                <p className="mt-1 text-xs text-red-600">Rejeição: {m.motivoRejeicao}</p>
              )}
            </div>
          ))}
          {modelos.length === 0 && (
            <p className="text-xs text-muted-foreground">Nenhum modelo ainda.</p>
          )}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Disparos para a carteira</h2>
        <FormNovoDisparo modelos={modelos} carteira={carteira} aoDisparar={recarregar} />
        <div className="space-y-2">
          {disparos.map((d) => (
            <LinhaDisparo key={d.id} d={d} />
          ))}
          {disparos.length === 0 && (
            <p className="text-xs text-muted-foreground">Nenhum disparo ainda.</p>
          )}
        </div>
      </section>
    </main>
  );
}
