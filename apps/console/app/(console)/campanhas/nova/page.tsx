'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, Vazio } from '@/components/ui/card';
import { Chip, Eyebrow } from '@/components/ui/chip';
import { Campo, Input, Opcao } from '@/components/ui/input';
import { PreviewWhatsApp } from '@/components/ui/whatsapp';
import { preencherModelo, variaveisDoCorpo } from '@/lib/campanhas';
import { api, type ContatoCarteira, type Modelo } from '@/lib/console-api';
import { nomeExibicao, telefoneBonito } from '@/lib/formatos';
import { STATUS_MODELO } from '@/lib/rotulos';
import { cn } from '@/lib/utils';
import { useInstalacao } from '../../layout';

/**
 * Nova campanha (design 5.3.2) em 3 passos sobre o que a 013 entrega: público
 * é a carteira (contatos com vínculo), a mensagem é um modelo aprovado na Meta
 * com variáveis globais, e o envio é imediato. Agendamento, ritmo, exclusões
 * automáticas e aprovação de gestor chegam com a campanha segmentada.
 */

const PASSOS = ['Público', 'Mensagem', 'Revisão e envio'] as const;

export default function NovaCampanhaPage() {
  const router = useRouter();
  const instalacao = useInstalacao();
  const [passo, setPasso] = useState(1);
  const [nome, setNome] = useState('');
  /** '' ⇒ usa a meta global da instalação (017). */
  const [metaPct, setMetaPct] = useState('');
  const [carteira, setCarteira] = useState<ContatoCarteira[]>([]);
  const [modelos, setModelos] = useState<Modelo[]>([]);
  const [busca, setBusca] = useState('');
  const [selecionados, setSelecionados] = useState<Set<string>>(new Set());
  const [modeloId, setModeloId] = useState('');
  const [valores, setValores] = useState<string[]>([]);
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    api
      .carteira()
      .then((r) => setCarteira(r.contatos))
      .catch(() => {});
    api
      .modelos()
      .then((r) => setModelos(r.modelos))
      .catch(() => {});
  }, []);

  const aprovados = useMemo(() => modelos.filter((m) => m.statusMeta === 'aprovado'), [modelos]);
  const modelo = aprovados.find((m) => m.id === modeloId) ?? null;
  const nVars = modelo ? variaveisDoCorpo(modelo.corpo).length : 0;
  const valoresOk = valores.slice(0, nVars).filter((v) => v?.trim()).length === nVars;

  const filtrados = carteira.filter((c) => {
    const q = busca.trim().toLowerCase();
    if (!q) return true;
    return (
      (c.nome ?? '').toLowerCase().includes(q) || c.waId.includes(q.replaceAll(/\D/g, '') || q)
    );
  });

  function alternar(waId: string) {
    setSelecionados((s) => {
      const novo = new Set(s);
      if (novo.has(waId)) novo.delete(waId);
      else novo.add(waId);
      return novo;
    });
  }

  const podeContinuar =
    passo === 1 ? selecionados.size > 0 : passo === 2 ? !!modelo && valoresOk : true;

  // meta de conversão (017): vazio = global; senão, percentual válido em bps
  const metaGlobalBps = instalacao?.campanhas.metaConversaoBps ?? null;
  const metaBps =
    metaPct.trim() === '' ? null : Math.round(Number(metaPct.replace(',', '.')) * 100);
  const metaInvalida =
    metaBps !== null && (!Number.isFinite(metaBps) || metaBps < 0 || metaBps > 10_000);

  async function disparar() {
    if (!modelo || metaInvalida) return;
    setEnviando(true);
    setErro(null);
    try {
      const r = await api.criarDisparo({
        modeloId: modelo.id,
        variaveis: valores.slice(0, nVars).map((v) => v.trim()),
        waIds: [...selecionados],
        nome: nome.trim() || undefined,
        metaConversaoBps: metaBps !== null && metaBps !== metaGlobalBps ? metaBps : undefined,
      });
      router.push(`/campanhas/${r.disparoId}`);
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e));
      setEnviando(false);
    }
  }

  const titulo = ['Quem vai receber', 'Qual mensagem', 'Revisar e enviar'][passo - 1];

  return (
    <main className="mx-auto flex h-full w-full max-w-[1400px] flex-wrap items-start gap-7 overflow-y-auto px-8 py-7">
      <aside className="flex flex-[0_1_180px] flex-col gap-1">
        <Link href="/campanhas" className="mb-3 text-[12.5px] text-text-3 hover:text-brand">
          ← Cancelar
        </Link>
        {PASSOS.map((rotulo, i) => {
          const n = i + 1;
          const on = n === passo;
          const feito = n < passo;
          return (
            <button
              key={rotulo}
              type="button"
              onClick={() => feito && setPasso(n)}
              disabled={!feito && !on}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-[10px] px-3 py-2.5 text-left',
                on && 'bg-surface',
                !feito && !on && 'cursor-default',
              )}
            >
              <span
                className={cn(
                  'inline-flex size-6 shrink-0 items-center justify-center rounded-full font-mono text-[11px]',
                  on
                    ? 'bg-brand text-white'
                    : feito
                      ? 'bg-ink text-white'
                      : 'bg-surface-3 text-text-3',
                )}
              >
                {n}
              </span>
              <span
                className={cn(
                  'text-[13px] font-semibold',
                  on ? 'text-ink' : feito ? 'text-text-2' : 'text-text-3',
                )}
              >
                {rotulo}
              </span>
            </button>
          );
        })}
      </aside>

      <section className="flex min-w-0 flex-[1_1_420px] flex-col gap-5">
        <div>
          <Eyebrow className="mb-1.5">
            Nova campanha · passo {passo} de {PASSOS.length}
          </Eyebrow>
          <h1 className="m-0 font-heading text-[26px] font-semibold tracking-[-.02em]">{titulo}</h1>
        </div>

        {passo === 1 && (
          <Card className="flex flex-col gap-4 p-5">
            <Campo
              rotulo="Nome da campanha"
              dica="opcional · aparece na lista e no relatório; sem nome, vale o nome do modelo"
              className="max-w-md"
            >
              <Input
                value={nome}
                onChange={(e) => setNome(e.target.value)}
                placeholder="ex.: Lembrete 31–90 set/26"
                maxLength={80}
              />
            </Campo>
            <div className="flex flex-wrap items-center gap-3">
              <Input
                compacto
                value={busca}
                onChange={(e) => setBusca(e.target.value)}
                placeholder="Buscar na carteira por nome ou telefone"
                className="max-w-sm"
              />
              <Opcao
                checked={carteira.length > 0 && selecionados.size === carteira.length}
                onChange={(e) =>
                  setSelecionados(
                    e.target.checked ? new Set(carteira.map((c) => c.waId)) : new Set(),
                  )
                }
              >
                Carteira inteira{' '}
                <span className="font-mono text-[11px] text-text-3">{carteira.length}</span>
              </Opcao>
            </div>
            <div className="max-h-[420px] overflow-y-auto rounded-[10px] border border-line">
              {filtrados.map((c) => (
                <label
                  key={c.waId}
                  className="flex cursor-pointer items-center gap-3 border-b border-line-soft px-3 py-2 text-[13px] last:border-b-0 hover:bg-background"
                >
                  <input
                    type="checkbox"
                    className="accent-ink"
                    checked={selecionados.has(c.waId)}
                    onChange={() => alternar(c.waId)}
                  />
                  <span className="flex-1 truncate font-medium">
                    {nomeExibicao(c.nome, c.waId)}
                  </span>
                  <span className="font-mono text-[11.5px] text-text-3">
                    {telefoneBonito(c.waId)}
                  </span>
                  <span className="font-mono text-[11px] text-text-3">
                    contrato {c.clienteErpId}
                  </span>
                </label>
              ))}
              {filtrados.length === 0 && (
                <p className="m-0 p-4 text-xs text-text-3">
                  {carteira.length === 0
                    ? 'Carteira vazia — os contatos com vínculo verificado vêm do cadastro (contatos.yaml no piloto).'
                    : 'Ninguém com esse nome ou telefone.'}
                </p>
              )}
            </div>
            <p className="m-0 text-xs text-text-3">
              A carteira são os contatos com vínculo verificado ao contrato. Segmentação por faixa
              de atraso, tipo de parcela e exclusões automáticas chegam com a campanha segmentada.
            </p>
          </Card>
        )}

        {passo === 2 && (
          <>
            {aprovados.length === 0 ? (
              <Vazio
                titulo="Nenhum modelo aprovado"
                texto="A Meta precisa aprovar um modelo antes de ele sair em campanha. Crie e sincronize os modelos em Configurações › Canal WhatsApp."
                acao={
                  <Link href="/config?t=canal" className="text-[13px] font-semibold">
                    Ir para modelos →
                  </Link>
                }
              />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {aprovados.map((m) => {
                  const on = m.id === modeloId;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => {
                        setModeloId(m.id);
                        setValores([]);
                      }}
                      className={cn(
                        'flex flex-col gap-2 rounded-[14px] border bg-surface p-4 text-left transition-shadow',
                        on
                          ? 'border-ink shadow-[0_4px_14px_rgba(20,20,22,.05)]'
                          : 'border-line hover:border-line-strong',
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-xs font-medium">{m.nome}</span>
                        <Chip papel={STATUS_MODELO[m.statusMeta].papel}>
                          {STATUS_MODELO[m.statusMeta].rotulo}
                        </Chip>
                      </div>
                      <div className="line-clamp-3 whitespace-pre-wrap text-[13px] text-text-2">
                        {m.corpo}
                      </div>
                      <div className="font-mono text-[10.5px] text-text-3">
                        {m.categoria} · {m.idioma} · {variaveisDoCorpo(m.corpo).length} variáveis
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
            {modelo && nVars > 0 && (
              <Card className="flex flex-col gap-3 p-5">
                <div className="text-xs font-semibold text-text-2">
                  Variáveis do modelo{' '}
                  <span className="font-mono text-[11px] font-normal text-text-3">
                    {modelo.nome}
                  </span>
                </div>
                <p className="m-0 text-xs text-text-3">
                  Os valores valem para todos os destinatários (variável por cotista chega com a
                  campanha segmentada).
                </p>
                {Array.from({ length: nVars }, (_, i) => (
                  <Campo
                    // biome-ignore lint/suspicious/noArrayIndexKey: posição É a identidade ({{i+1}})
                    key={i}
                    rotulo={`Variável {{${i + 1}}}`}
                  >
                    <Input
                      value={valores[i] ?? ''}
                      onChange={(e) =>
                        setValores((v) => {
                          const novo = [...v];
                          novo[i] = e.target.value;
                          return novo;
                        })
                      }
                    />
                  </Campo>
                ))}
              </Card>
            )}
          </>
        )}

        {passo === 3 && modelo && (
          <Card className="flex flex-col gap-3.5 p-5">
            <div className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-2.5 text-[13.5px]">
              <span className="text-text-3">Campanha</span>
              <span>
                <b>{nome.trim() || modelo.nome}</b>
                {!nome.trim() && (
                  <span className="text-text-3"> · sem nome próprio, vale o do modelo</span>
                )}
              </span>
              <span className="text-text-3">Público</span>
              <span>
                <b>{selecionados.size} destinatários</b> · carteira com vínculo verificado
              </span>
              <span className="text-text-3">Modelo</span>
              <span className="font-mono text-[12.5px]">{modelo.nome}</span>
              {nVars > 0 && (
                <>
                  <span className="text-text-3">Variáveis</span>
                  <span>{valores.slice(0, nVars).join(' · ')}</span>
                </>
              )}
              <span className="text-text-3">Envio</span>
              <span>agora, ao confirmar · a fila envia e atualiza o funil em tempo real</span>
            </div>
            <Campo
              rotulo="Meta de conversão (%)"
              dica={`pagas ÷ entregues, comparada no relatório de campanhas · padrão da instalação: ${
                metaGlobalBps !== null ? `${metaGlobalBps / 100}%` : '…'
              }`}
              className="max-w-[260px]"
            >
              <Input
                compacto
                type="number"
                min={0}
                max={100}
                step={0.5}
                value={
                  metaPct === '' && metaGlobalBps !== null ? String(metaGlobalBps / 100) : metaPct
                }
                onChange={(e) => setMetaPct(e.target.value)}
              />
            </Campo>
            {metaInvalida && <p className="m-0 text-xs text-brand">A meta vai de 0 a 100%.</p>}
            <div className="rounded-[10px] border border-info-2/25 bg-info-2/8 px-3 py-2.5 text-[12.5px] text-info">
              Quem responder cai na fila de atendimento com a campanha como origem; o agente segue a
              conversa e escala o que precisar de gente.
            </div>
            {erro && <p className="m-0 text-xs text-brand">{erro}</p>}
            <Button
              size="lg"
              onClick={disparar}
              disabled={enviando || metaInvalida}
              className="self-start"
            >
              {enviando ? 'Enfileirando…' : `Disparar para ${selecionados.size} contato(s)`}
            </Button>
          </Card>
        )}

        <div className="flex justify-between">
          <Button
            variant="outline"
            size="md"
            onClick={() => setPasso((p) => Math.max(1, p - 1))}
            className={cn(passo === 1 && 'invisible')}
          >
            Voltar
          </Button>
          {passo < PASSOS.length && (
            <Button
              variant="ink"
              size="md"
              disabled={!podeContinuar}
              onClick={() => setPasso((p) => p + 1)}
            >
              Continuar →
            </Button>
          )}
        </div>
      </section>

      <aside className="flex max-w-[360px] flex-[1_1_300px] flex-col gap-3">
        <Eyebrow>Pré-visualização · WhatsApp</Eyebrow>
        <PreviewWhatsApp
          texto={
            modelo
              ? preencherModelo(modelo.corpo, valores)
              : 'Escolha um modelo aprovado no passo 2 para ver a mensagem como o cotista recebe.'
          }
          rodape={modelo?.rodape}
        />
        <Card className="flex flex-col gap-1.5 p-3.5 text-[12.5px]">
          <div className="flex justify-between">
            <span className="text-text-3">Carteira</span>
            <b>{carteira.length}</b>
          </div>
          <div className="flex justify-between border-t border-line-soft pt-1.5">
            <span className="text-text-3">Destinatários</span>
            <b className="font-heading text-base">{selecionados.size}</b>
          </div>
        </Card>
      </aside>
    </main>
  );
}
