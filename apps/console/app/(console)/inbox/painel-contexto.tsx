'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Chip, Eyebrow } from '@/components/ui/chip';
import { Abas } from '@/components/ui/tabela';
import type { CobrancaView, ConversaDetalhe, ReservaView } from '@/lib/console-api';
import { dataCurta, dataHoraCurta, duracao, reaisDeCentavos, telefoneBonito } from '@/lib/formatos';
import {
  METODO_COBRANCA,
  motivoLabel,
  STATUS_COBRANCA,
  STATUS_DESTINATARIO,
  STATUS_RESERVA,
} from '@/lib/rotulos';
import { cn } from '@/lib/utils';

/**
 * Coluna direita do atendimento: quem é o cotista (vínculo, contrato, resumo
 * financeiro do ERP), cobranças geradas nesta conversa e a campanha de origem.
 */

type Aba = 'contexto' | 'cobs' | 'reservas' | 'origem';

function Secao({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <Eyebrow>{titulo}</Eyebrow>
      {children}
    </div>
  );
}

function Grade({ itens }: { itens: [string, React.ReactNode][] }) {
  return (
    <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
      {itens.map(([k, v]) => (
        <div key={k} className="contents">
          <span className="text-text-3">{k}</span>
          <span className="min-w-0 break-words">{v}</span>
        </div>
      ))}
    </div>
  );
}

function faixaAtraso(dias: number): string {
  if (dias <= 0) return 'em dia';
  if (dias <= 30) return '1–30 dias';
  if (dias <= 90) return '31–90 dias';
  if (dias <= 180) return '91–180 dias';
  return '> 180 dias';
}

export function PainelContexto({
  detalhe,
  cobrancas,
  reservas,
  aoFechar,
}: {
  detalhe: ConversaDetalhe;
  cobrancas: CobrancaView[] | null | undefined;
  /** 038: `undefined` = carregando, `null` = módulo desligado. */
  reservas: ReservaView[] | null | undefined;
  aoFechar: () => void;
}) {
  const [aba, setAba] = useState<Aba>('contexto');
  // biome-ignore lint/correctness/useExhaustiveDependencies: volta para Contexto ao trocar de conversa
  useEffect(() => setAba('contexto'), [detalhe.conversaId]);

  const perfil = detalhe.perfilErp as {
    tier?: string;
    status?: string;
    periodos?: number;
    pontos?: number;
    cota_codigo?: string;
    bloco?: string;
    uh?: string;
  } | null;
  const fin = detalhe.financeiro;
  const t = detalhe.ticket;

  return (
    <aside className="flex h-full min-h-0 flex-col border-l border-line bg-surface">
      <div className="flex items-center">
        <Abas<Aba>
          className="flex-1"
          itens={[
            { id: 'contexto', rotulo: 'Contexto' },
            { id: 'cobs', rotulo: 'Cobranças' },
            { id: 'reservas', rotulo: 'Reservas' },
            { id: 'origem', rotulo: 'Origem' },
          ]}
          ativa={aba}
          aoMudar={setAba}
        />
        <button
          type="button"
          onClick={aoFechar}
          aria-label="Fechar contexto"
          className="mr-2 flex size-8 items-center justify-center rounded-[8px] border border-line text-text-3 xl:hidden"
        >
          ×
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        {aba === 'contexto' && (
          <>
            {detalhe.clienteErpId ? (
              <>
                <Secao titulo="Identificação">
                  <Grade
                    itens={[
                      [
                        'Telefone',
                        <span key="tel" className="font-mono text-xs">
                          {telefoneBonito(detalhe.waId)}
                        </span>,
                      ],
                      [
                        'Vínculo',
                        <span key="v" className="font-semibold text-ok">
                          Confirmado ✓
                        </span>,
                      ],
                      [
                        'Contrato',
                        <span key="c" className="font-mono text-xs">
                          {detalhe.clienteErpId}
                        </span>,
                      ],
                    ]}
                  />
                </Secao>
                <Secao titulo="Contrato">
                  {perfil ? (
                    <div className="rounded-[12px] border border-line bg-surface-2 p-3">
                      <Grade
                        itens={[
                          ['Produto', <b key="p">{perfil.tier ?? '—'}</b>],
                          [
                            'Cota',
                            <span key="c" className="font-mono text-xs">
                              {perfil.cota_codigo ?? '—'}
                            </span>,
                          ],
                          [
                            'Unidade',
                            `${perfil.bloco ?? '—'}${perfil.uh ? ` · UH ${perfil.uh}` : ''}`,
                          ],
                          [
                            'Status',
                            <span
                              key="s"
                              className={cn(
                                'font-semibold capitalize',
                                perfil.status === 'ativo' ? 'text-ok' : 'text-warn',
                              )}
                            >
                              {perfil.status ?? '—'}
                            </span>,
                          ],
                          [
                            'Uso',
                            `${perfil.periodos ?? '—'} período(s)/ano · ${perfil.pontos ?? '—'} pontos`,
                          ],
                        ]}
                      />
                    </div>
                  ) : (
                    <p className="m-0 text-xs text-text-3">ERP indisponível para este contrato.</p>
                  )}
                </Secao>
                <Secao titulo="Financeiro">
                  {fin ? (
                    <>
                      <div className="grid grid-cols-2 gap-2">
                        <div className="rounded-[9px] border border-line p-2.5">
                          <div className="text-[11px] text-text-3">Parcelas</div>
                          <div
                            className={cn(
                              'font-heading text-sm font-semibold',
                              fin.vencidas > 0 ? 'text-brand' : 'text-ok',
                            )}
                          >
                            {fin.vencidas > 0
                              ? `${fin.vencidas} vencida${fin.vencidas > 1 ? 's' : ''} · ${fin.maiorAtrasoDias} dias`
                              : 'em dia'}
                          </div>
                        </div>
                        <div className="rounded-[9px] border border-line p-2.5">
                          <div className="text-[11px] text-text-3">Saldo vencido</div>
                          <div className="font-heading text-sm font-semibold">
                            {reaisDeCentavos(fin.saldoVencidoCentavos)}
                          </div>
                        </div>
                      </div>
                      <div className="text-xs text-text-3">
                        Faixa de atraso:{' '}
                        <b className="text-text-2">{faixaAtraso(fin.maiorAtrasoDias)}</b>
                        {fin.vencimentoMaisAntigo && (
                          <> · mais antiga {dataCurta(fin.vencimentoMaisAntigo)}</>
                        )}
                      </div>
                    </>
                  ) : (
                    <p className="m-0 text-xs text-text-3">
                      Sem leitura financeira (módulo desligado ou ERP indisponível).
                    </p>
                  )}
                </Secao>
              </>
            ) : (
              <div className="rounded-[12px] border border-warn-2/35 bg-warn-2/14 p-3 text-[13px] text-warn">
                <b>Sem vínculo com cotista.</b> O agente só responde perguntas gerais e, se houver
                interesse em comprar, o SDR qualifica o lead. O vínculo nasce do cadastro de
                contatos verificado.
              </div>
            )}
            <Secao titulo="Escalonamento">
              <p className="m-0 text-[13px] text-text-2">
                {t.motivoEscalonamento ? (
                  <>
                    {motivoLabel(t.motivoEscalonamento)}
                    {t.status === 'aguardando_humano' && t.esperaSegundos !== null && (
                      <span className="text-text-3"> · há {duracao(t.esperaSegundos)}</span>
                    )}
                    <span className="block font-mono text-[10.5px] text-text-3">
                      {t.motivoEscalonamento}
                    </span>
                  </>
                ) : (
                  'Sem escalonamento registrado.'
                )}
              </p>
            </Secao>
          </>
        )}

        {aba === 'cobs' && (
          <>
            {cobrancas === undefined && (
              <p className="m-0 py-6 text-center text-[13px] text-text-3">Carregando…</p>
            )}
            {cobrancas === null && (
              <p className="m-0 py-6 text-center text-[13px] text-text-3">
                Cobranças indisponíveis nesta instalação (módulo de pagamentos desligado).
              </p>
            )}
            {cobrancas?.map((k) => {
              const s = STATUS_COBRANCA[k.status];
              return (
                <Link
                  key={k.id}
                  href={`/cobrancas?k=${k.id}`}
                  className="flex flex-col gap-1.5 rounded-[12px] border border-line bg-surface p-3 no-underline hover:border-line-strong"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-heading text-[15px] font-semibold text-ink">
                      {reaisDeCentavos(k.valorCentavos)}
                    </span>
                    <span className="font-mono text-[11px] text-text-3">
                      {METODO_COBRANCA[k.metodo]}
                    </span>
                  </div>
                  <Chip papel={s.papel} className="self-start">
                    {s.rotulo}
                  </Chip>
                  <span className="text-[11.5px] text-text-3">
                    {k.parcelas ?? '—'} · gerada {dataHoraCurta(k.criadoEm)}
                  </span>
                </Link>
              );
            })}
            {cobrancas && cobrancas.length === 0 && (
              <p className="m-0 py-6 text-center text-[13px] text-text-3">
                Nenhuma cobrança gerada nesta conversa. Ela nasce quando o cotista diz "quero
                pagar".
              </p>
            )}
          </>
        )}

        {aba === 'reservas' && (
          <>
            {reservas === undefined && (
              <p className="m-0 py-6 text-center text-[13px] text-text-3">Carregando…</p>
            )}
            {reservas === null && (
              <p className="m-0 py-6 text-center text-[13px] text-text-3">
                Reservas indisponíveis nesta instalação (módulo de reserva desligado).
              </p>
            )}
            {reservas?.map((r) => {
              const s = STATUS_RESERVA[r.status];
              return (
                <Link
                  key={r.id}
                  href={`/reservas?k=${r.id}`}
                  className="flex flex-col gap-1.5 rounded-[12px] border border-line bg-surface p-3 no-underline hover:border-line-strong"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-heading text-[15px] font-semibold text-ink">
                      {dataCurta(r.checkIn)} → {dataCurta(r.checkOut)}
                    </span>
                    <span className="font-mono text-[11px] text-text-3">
                      {r.custoPontos.toLocaleString('pt-BR')} pts
                    </span>
                  </div>
                  <Chip papel={s.papel} className="self-start">
                    {s.rotulo}
                  </Chip>
                  <span className="text-[11.5px] text-text-3">
                    {r.hotel ?? '—'} · {r.tipoUh ?? '—'} · taxa {reaisDeCentavos(r.taxaCentavos)}
                  </span>
                </Link>
              );
            })}
            {reservas && reservas.length === 0 && (
              <p className="m-0 py-6 text-center text-[13px] text-text-3">
                Nenhuma reserva nesta conversa. Ela nasce quando o cotista diz "quero usar minha
                semana".
              </p>
            )}
          </>
        )}

        {aba === 'origem' &&
          (detalhe.origem ? (
            <div className="rounded-[12px] border border-line p-3">
              <Grade
                itens={[
                  [
                    'Campanha',
                    <Link
                      key="c"
                      href={`/campanhas/${detalhe.origem.disparoId}`}
                      className="font-semibold"
                    >
                      {detalhe.origem.modelo}
                    </Link>,
                  ],
                  [
                    'Modelo',
                    <span key="m" className="font-mono text-xs">
                      {detalhe.origem.modelo}
                    </span>,
                  ],
                  ['Envio', dataHoraCurta(detalhe.origem.enviadoEm)],
                  [
                    'Destinatário',
                    <Chip
                      key="d"
                      papel={STATUS_DESTINATARIO[detalhe.origem.statusDestinatario].papel}
                    >
                      {STATUS_DESTINATARIO[detalhe.origem.statusDestinatario].rotulo}
                    </Chip>,
                  ],
                ]}
              />
            </div>
          ) : (
            <p className="m-0 py-6 text-center text-[13px] text-text-3">
              Conversa espontânea · o cotista escreveu primeiro.
            </p>
          ))}
      </div>
    </aside>
  );
}
