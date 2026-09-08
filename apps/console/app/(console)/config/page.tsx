'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { Card, Vazio } from '@/components/ui/card';
import { Chip, Eyebrow, Ponto } from '@/components/ui/chip';
import { Avatar } from '@/components/ui/whatsapp';
import { api, type PessoaEquipe } from '@/lib/console-api';
import { dataCurta, iniciais, reaisDeCentavos } from '@/lib/formatos';
import { GATILHOS_ESCALADA } from '@/lib/rotulos';
import { cn } from '@/lib/utils';
import { useInstalacao } from '../layout';
import { Modelos } from './modelos';

/**
 * Configurações (design 5.8): canal WhatsApp e modelos, regras e alçadas (só
 * leitura — vivem em client.yaml/.env), equipe e PSP. Edição pela UI e as
 * seções de ERP/skills ficam para a fase de Configurações (M4).
 */

type Aba = 'canal' | 'regras' | 'equipe' | 'psp' | 'erp' | 'skills';
const ABAS: { id: Aba; rotulo: string }[] = [
  { id: 'canal', rotulo: 'Canal WhatsApp' },
  { id: 'regras', rotulo: 'Regras e alçadas' },
  { id: 'equipe', rotulo: 'Equipe' },
  { id: 'psp', rotulo: 'Pagamentos (PSP)' },
  { id: 'erp', rotulo: 'Integração ERP' },
  { id: 'skills', rotulo: 'Skills do agente' },
];

function Valor({ rotulo, valor, dica }: { rotulo: string; valor: React.ReactNode; dica?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-semibold text-text-2">{rotulo}</span>
      <div className="flex h-[42px] items-center rounded-[10px] border border-line bg-background px-3.5 font-mono text-sm">
        {valor}
      </div>
      {dica && <span className="text-[11px] text-text-3">{dica}</span>}
    </div>
  );
}

function Equipe() {
  const [pessoas, setPessoas] = useState<PessoaEquipe[] | null>(null);
  useEffect(() => {
    api
      .equipe()
      .then((r) => setPessoas(r.pessoas))
      .catch(() => setPessoas([]));
  }, []);
  return (
    <>
      <Card className="overflow-hidden">
        <div className="grid grid-cols-[1.5fr_1.5fr_1fr_1fr] gap-3 border-b border-line px-4 py-2.5 font-mono text-[10.5px] uppercase tracking-[.08em] text-text-3">
          <span>Pessoa</span>
          <span>E-mail</span>
          <span>Papel</span>
          <span>Desde</span>
        </div>
        {(pessoas ?? []).map((u) => (
          <div
            key={u.id}
            className="grid grid-cols-[1.5fr_1.5fr_1fr_1fr] items-center gap-3 border-b border-line-soft px-4 py-3 text-[13px]"
          >
            <span className="flex items-center gap-2.5">
              <Avatar iniciais={iniciais(u.nome)} tom="escuro" tamanho={30} />
              <b className="truncate">{u.nome}</b>
            </span>
            <span className="truncate text-text-2">{u.email}</span>
            <span>
              <Chip papel={u.role === 'curador' ? 'ok' : 'info'}>
                {u.role === 'curador' ? 'Curador' : 'Atendente'}
              </Chip>
            </span>
            <span className="font-mono text-[11.5px] text-text-2">{dataCurta(u.criadoEm)}</span>
          </div>
        ))}
        {pessoas && pessoas.length === 0 && (
          <p className="m-0 p-4 text-xs text-text-3">Ninguém cadastrado.</p>
        )}
        {!pessoas && <p className="m-0 p-4 text-xs text-text-3">Carregando…</p>}
      </Card>
      <p className="m-0 text-xs text-text-3">
        Hoje os papéis são atendente e curador; convite, edição e os papéis de gestor, comercial e
        admin chegam com a fase de Configurações.
      </p>
    </>
  );
}

function ConfigConteudo() {
  const params = useSearchParams();
  const router = useRouter();
  const instalacao = useInstalacao();
  const aba = (ABAS.find((a) => a.id === params.get('t'))?.id ?? 'canal') as Aba;
  const titulo = ABAS.find((a) => a.id === aba)?.rotulo ?? '';
  const i = instalacao;

  return (
    <main className="mx-auto grid h-full w-full max-w-[1200px] grid-cols-1 items-start gap-7 overflow-y-auto px-8 py-7 md:grid-cols-[220px_minmax(0,1fr)]">
      <aside className="flex flex-col gap-0.5 md:sticky md:top-0">
        <Eyebrow className="px-3 pb-2.5">Configurações</Eyebrow>
        {ABAS.map((a) => (
          <button
            key={a.id}
            type="button"
            onClick={() => router.replace(`/config?t=${a.id}`)}
            className={cn(
              'rounded-[9px] px-3 py-2.5 text-left text-[13px] font-semibold transition-colors hover:bg-surface-3',
              aba === a.id ? 'bg-surface text-ink' : 'text-text-2',
            )}
          >
            {a.rotulo}
          </button>
        ))}
      </aside>
      <section className="flex min-w-0 flex-col gap-4">
        <h1 className="m-0 font-heading text-2xl font-semibold tracking-[-.02em]">{titulo}</h1>

        {aba === 'canal' && (
          <>
            <Card className="grid grid-cols-[auto_1fr] items-center gap-x-5 gap-y-3 p-5 text-[13.5px]">
              <span className="text-text-3">Instalação</span>
              <span className="font-semibold">{i?.nome ?? '…'}</span>
              <span className="text-text-3">Gateway</span>
              <span className="flex items-center gap-2">
                <Ponto tom={i?.canal.gateway === 'meta' ? 'ok' : 'warn'} />
                {i?.canal.gateway === 'meta'
                  ? 'Meta Cloud API conectada'
                  : 'Modo teste · mensagens só no log do servidor'}
              </span>
              <span className="text-text-3">Modelos (WABA)</span>
              <span className="flex items-center gap-2">
                <Ponto tom={i?.canal.metaConfigurada ? 'ok' : 'risk'} />
                {i?.canal.metaConfigurada
                  ? 'WABA configurada · gestão de modelos ativa'
                  : 'WABA não configurada · modelos indisponíveis'}
              </span>
              <span className="text-text-3">Simulador</span>
              <span>{i?.canal.simulador ? 'ligado (dev) · /simulador' : 'desligado'}</span>
            </Card>
            <Modelos />
          </>
        )}

        {aba === 'regras' && (
          <>
            <Card className="flex flex-col gap-3.5 p-5">
              <div className="font-semibold">Alçadas do agente</div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Valor
                  rotulo="Teto para emissão automática"
                  valor={i ? reaisDeCentavos(i.alcadas.tetoAprovacaoCentavos) : '…'}
                  dica="acima disso a cobrança espera aprovação"
                />
                <Valor
                  rotulo="Cobranças por conversa por dia"
                  valor={i?.alcadas.maxCobrancasDia ?? '…'}
                  dica="além disso, humano"
                />
                <Valor
                  rotulo="Vencimento padrão da cobrança"
                  valor={i ? `${i.alcadas.diasVencimento} dias após emissão` : '…'}
                />
                <Valor
                  rotulo="Desconto máximo do agente (vendas)"
                  valor={
                    i ? `${i.alcadas.descontoMaxBps / 100}% (${i.alcadas.descontoMaxBps} bps)` : '…'
                  }
                  dica="sobre o valor de tabela da cota"
                />
                <Valor
                  rotulo="Propostas por lead por dia"
                  valor={i?.alcadas.maxPropostasDia ?? '…'}
                />
                <Valor
                  rotulo="Resposta máxima"
                  valor={i ? `${i.limites.maxCaracteresResposta} caracteres` : '…'}
                />
                <Valor
                  rotulo="Tool calls por turno"
                  valor={i?.limites.maxToolCallsPorTurno ?? '…'}
                />
                <Valor
                  rotulo="Mensagens de contexto"
                  valor={i?.limites.maxMensagensContexto ?? '…'}
                />
              </div>
              <p className="m-0 text-xs text-text-3">
                Definidos em client.yaml e .env da instalação. Edição pela interface chega com a
                fase de Configurações.
              </p>
            </Card>
            <Card className="flex flex-col gap-2.5 p-5">
              <div className="font-semibold">Gatilhos de escalada obrigatória</div>
              {GATILHOS_ESCALADA.map((g) => {
                const ativo =
                  g.codigo === 'aprovacao_cobranca'
                    ? !!i?.modulos.pagamentos
                    : g.codigo === 'desconto_acima_alcada'
                      ? !!i?.modulos.sdr
                      : true;
                return (
                  <div
                    key={g.codigo}
                    className="grid grid-cols-[auto_1fr_auto] items-center gap-3 border-t border-line-soft py-2.5 text-[13px]"
                  >
                    <input
                      type="checkbox"
                      checked={ativo}
                      readOnly
                      disabled
                      className="accent-ink"
                    />
                    <span>
                      <b>{g.rotulo}</b>
                      <span className="block text-xs text-text-3">{g.desc}</span>
                    </span>
                    <span className="font-mono text-[11px] text-text-3">{g.codigo}</span>
                  </div>
                );
              })}
              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-text-3">
                <span>Temas sensíveis:</span>
                {(i?.guardrails.temasSensiveis ?? []).map((t) => (
                  <Chip key={t} papel="off">
                    {t}
                  </Chip>
                ))}
              </div>
            </Card>
          </>
        )}

        {aba === 'equipe' && <Equipe />}

        {aba === 'psp' && (
          <Card className="grid grid-cols-[auto_1fr] items-center gap-x-5 gap-y-3 p-5 text-[13.5px]">
            <span className="text-text-3">Módulo</span>
            <span>
              {i?.modulos.pagamentos ? 'pagamentos pelo WhatsApp ligado' : 'pagamentos desligado'}
            </span>
            <span className="text-text-3">PSP</span>
            <span className="flex items-center gap-2">
              <Ponto tom={i?.psp?.nome === 'asaas' ? 'ok' : 'warn'} />
              {i?.psp ? `${i.psp.nome} · ${i.psp.ambiente}` : '—'}
            </span>
            <span className="text-text-3">Métodos</span>
            <span>Boleto · PIX · Cartão (link)</span>
            <span className="text-text-3">Cobranças</span>
            <Link href="/cobrancas">ver cobranças →</Link>
            {i?.psp?.nome === 'simulado' && (
              <p className="col-span-2 m-0 rounded-[10px] border border-warn-2/35 bg-warn-2/14 px-3 py-2 text-xs text-warn">
                PSP simulado: links e códigos são fictícios. Configure ASAAS_API_KEY para usar o
                sandbox do Asaas.
              </p>
            )}
          </Card>
        )}

        {(aba === 'erp' || aba === 'skills') && (
          <Vazio
            texto={
              aba === 'erp'
                ? 'Integração ERP e catálogo de queries ficam fora desta rodada (M5): configuração por arquivo na instalação.'
                : 'As skills do agente são curadas em Aprendizado › Curadoria (papel curador). A configuração por aqui fica para a fase de Configurações.'
            }
            acao={
              aba === 'skills' ? (
                <Link href="/aprendizado?v=curadoria" className="text-[13px] font-semibold">
                  Ir para a curadoria →
                </Link>
              ) : undefined
            }
          />
        )}
      </section>
    </main>
  );
}

export default function ConfigPage() {
  return (
    <Suspense fallback={<main className="p-6 text-sm text-text-3">Carregando…</main>}>
      <ConfigConteudo />
    </Suspense>
  );
}
