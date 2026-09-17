import { describe, expect, it } from 'vitest';
import type { MensagemThread } from '../lib/console-api';
import {
  dataCurta,
  dataHoraCurta,
  duracao,
  ehCodigoPagamento,
  estadoJanela,
  horarioLista,
  iniciais,
  mesclarMensagens,
  nomeExibicao,
  porcentagem,
  prefixoAutor,
  prefixoSeAplica,
  reaisDeCentavos,
  semPrefixoAtendente,
  separadorDia,
  telefoneBonito,
  telefoneMascarado,
  tempoRelativo,
} from '../lib/formatos';
import { estadoLead, motivoLabel } from '../lib/rotulos';

const AGORA = new Date('2026-09-01T15:00:00');

function msg(parcial: Partial<MensagemThread> & { id: string }): MensagemThread {
  return {
    autor: 'contato',
    atendenteId: null,
    atendenteNome: null,
    texto: 'x',
    anexoNome: null,
    status: 'recebida',
    criadoEm: '2026-09-01T14:00:00',
    ...parcial,
  };
}

describe('formatos da tela de atendimento (#45)', () => {
  it('iniciais: duas palavras, fallback "?"', () => {
    expect(iniciais('Ana Atendente')).toBe('AA');
    expect(iniciais('Contrato 10001')).toBe('C1');
    expect(iniciais('maria')).toBe('M');
    expect(iniciais('')).toBe('?');
    expect(iniciais(null)).toBe('?');
  });

  it('telefoneBonito formata E.164 do Brasil', () => {
    expect(telefoneBonito('5511999990001')).toBe('+55 11 99999-0001');
    expect(telefoneBonito('551130004000')).toBe('+55 11 3000-4000');
    expect(telefoneBonito('14155552671')).toBe('+14155552671');
    expect(telefoneBonito(null)).toBe('—');
  });

  it('horarioLista: hoje HH:MM, ontem "Ontem", antes DD/MM', () => {
    expect(horarioLista('2026-09-01T08:05:00', AGORA)).toBe('08:05');
    expect(horarioLista('2026-08-31T22:00:00', AGORA)).toBe('Ontem');
    expect(horarioLista('2026-08-20T10:00:00', AGORA)).toBe('20/08');
  });

  it('separadorDia: Hoje / Ontem / DD/MM/AAAA', () => {
    expect(separadorDia('2026-09-01T08:05:00', AGORA)).toBe('Hoje');
    expect(separadorDia('2026-08-31T08:05:00', AGORA)).toBe('Ontem');
    expect(separadorDia('2026-08-20T08:05:00', AGORA)).toBe('20/08/2026');
  });

  it('estadoJanela: aberta, fechando (≤2h) e fechada', () => {
    expect(estadoJanela('2026-09-02T10:00:00', AGORA)).toEqual({ estado: 'aberta' });
    expect(estadoJanela('2026-09-01T15:30:00', AGORA)).toEqual({
      estado: 'fechando',
      rotulo: 'fecha em 30min',
    });
    expect(estadoJanela('2026-09-01T16:30:00', AGORA)).toEqual({
      estado: 'fechando',
      rotulo: 'fecha em 1h30min',
    });
    expect(estadoJanela('2026-09-01T14:59:00', AGORA)).toEqual({ estado: 'fechada' });
    expect(estadoJanela(null, AGORA)).toEqual({ estado: 'fechada' });
  });

  it('mesclarMensagens: sem duplicar, ordenado, versão nova vence (status)', () => {
    const antigas = [
      msg({ id: 'a', criadoEm: '2026-09-01T10:00:00' }),
      msg({ id: 'b', criadoEm: '2026-09-01T11:00:00', status: 'enviada', autor: 'bot' }),
    ];
    const novas = [
      msg({ id: 'b', criadoEm: '2026-09-01T11:00:00', status: 'lida', autor: 'bot' }),
      msg({ id: 'c', criadoEm: '2026-09-01T12:00:00' }),
    ];
    const resultado = mesclarMensagens(antigas, novas);
    expect(resultado.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    expect(resultado[1]?.status).toBe('lida');
  });

  it('prefixoSeAplica: só quando a última saída não é do próprio atendente', () => {
    const doBot = [msg({ id: 'a', autor: 'bot' })];
    const minha = [msg({ id: 'a', autor: 'atendente', atendenteId: 'eu' })];
    const deOutro = [msg({ id: 'a', autor: 'atendente', atendenteId: 'outra-pessoa' })];
    expect(prefixoSeAplica([], 'eu')).toBe(true);
    expect(prefixoSeAplica(doBot, 'eu')).toBe(true);
    expect(prefixoSeAplica(minha, 'eu')).toBe(false);
    expect(prefixoSeAplica(deOutro, 'eu')).toBe(true);
    // mensagem do contato DEPOIS da minha não muda quem falou por último na saída
    const minhaEContato = [
      msg({ id: 'a', autor: 'atendente', atendenteId: 'eu', criadoEm: '2026-09-01T10:00:00' }),
      msg({ id: 'b', autor: 'contato', criadoEm: '2026-09-01T10:05:00' }),
    ];
    expect(prefixoSeAplica(minhaEContato, 'eu')).toBe(false);
  });
});

describe('014 — formatos da página Cobranças', () => {
  it('centavos → reais e data do PSP → DD/MM/AAAA', () => {
    expect(reaisDeCentavos(85050)).toBe('R$ 850,50');
    expect(reaisDeCentavos(123456789)).toBe('R$ 1.234.567,89');
    expect(reaisDeCentavos(5)).toBe('R$ 0,05');
    expect(dataCurta('2026-09-05')).toBe('05/09/2026');
    expect(dataCurta('2026-09-05T00:00:00.000Z')).toBe('05/09/2026');
    expect(dataCurta(null)).toBe('—');
  });
});

describe('console redesenhado (2026-09) — formatos novos', () => {
  it('telefoneMascarado: 1º dígito + últimos 4 (pseudonimização das listas)', () => {
    expect(telefoneMascarado('5511999990002')).toBe('9…-0002');
    expect(telefoneMascarado('551130004000')).toBe('3…-4000');
    expect(telefoneMascarado('123')).toBe('—');
  });

  it('nomeExibicao: nome do cadastro, senão telefone', () => {
    expect(nomeExibicao('Maria S.', '5511999990117')).toBe('Maria S.');
    expect(nomeExibicao('  ', '5511999990117')).toBe('+55 11 99999-0117');
    expect(nomeExibicao(null, '5511999990117')).toBe('+55 11 99999-0117');
  });

  it('duracao: s, min, h+min, d', () => {
    expect(duracao(45)).toBe('45 s');
    expect(duracao(12 * 60)).toBe('12 min');
    expect(duracao(80 * 60)).toBe('1h20min');
    expect(duracao(3 * 3600)).toBe('3h');
    expect(duracao(2 * 86_400)).toBe('2 d');
    expect(duracao(null)).toBe('—');
  });

  it('tempoRelativo: agora, há N min, há N h, ontem, há N dias', () => {
    expect(tempoRelativo('2026-09-01T14:59:40', AGORA)).toBe('agora');
    expect(tempoRelativo('2026-09-01T14:52:00', AGORA)).toBe('há 8 min');
    expect(tempoRelativo('2026-09-01T12:30:00', AGORA)).toBe('há 2 h');
    expect(tempoRelativo('2026-08-31T18:40:00', AGORA)).toBe('ontem');
    expect(tempoRelativo('2026-08-29T10:12:00', AGORA)).toBe('há 3 dias');
    expect(tempoRelativo(null, AGORA)).toBe('—');
  });

  it('dataHoraCurta e porcentagem', () => {
    expect(dataHoraCurta('2026-09-12T09:00:00')).toBe('12/09 09:00');
    expect(dataHoraCurta(null)).toBe('—');
    expect(porcentagem(41, 318)).toBe('13%');
    expect(porcentagem(0, 0)).toBe('—');
  });

  it('prefixoAutor: quem falou por último no preview', () => {
    expect(prefixoAutor('contato')).toBe('');
    expect(prefixoAutor('bot')).toBe('Agente: ');
    expect(prefixoAutor('atendente', 'Ana Atendente')).toBe('Ana: ');
    expect(prefixoAutor('atendente', null)).toBe('Atendente: ');
    expect(prefixoAutor('campanha')).toBe('Campanha: ');
  });

  it('ehCodigoPagamento: PIX copia-e-cola e linha digitável vão em mono', () => {
    expect(
      ehCodigoPagamento(
        '00020126580014br.gov.bcb.pix0136a7f3c2e1-9b4d-4c8e-8f21-3d5e6a7b8c9d5204000053039865406125.005802BR',
      ),
    ).toBe(true);
    expect(ehCodigoPagamento('34191.79001 01043.510047 91020.150008 8 99870000062500')).toBe(true);
    expect(ehCodigoPagamento('Seu boleto está pronto! Valor: R$ 625,00')).toBe(false);
    expect(ehCodigoPagamento('sim')).toBe(false);
  });

  it('semPrefixoAtendente tira o *Nome* que o servidor prefixa', () => {
    expect(semPrefixoAtendente('*Ana Atendente*\n\nOi! Aqui é a Ana.')).toBe('Oi! Aqui é a Ana.');
    expect(semPrefixoAtendente('Sem prefixo')).toBe('Sem prefixo');
  });

  it('motivoLabel: códigos conhecidos em pt-BR, desconhecidos humanizados', () => {
    expect(motivoLabel('negociacao_preco')).toBe('Pedido de desconto / negociação');
    expect(motivoLabel('algo_novo_aqui')).toBe('Algo novo aqui');
    expect(motivoLabel(null)).toBe('Sem motivo registrado');
  });

  it('estadoLead: proposta aguardando aprovação sobrepõe o status do lead', () => {
    expect(estadoLead('proposta', { status: 'aguardando_aprovacao' })).toMatchObject({
      rotulo: 'Aguardando aprovação',
      papel: 'warn',
      codigo: 'aguardando_aprovacao',
    });
    expect(estadoLead('agendado', { status: 'aceita' })).toMatchObject({
      rotulo: 'Agendado',
      papel: 'ok',
    });
    expect(estadoLead('qualificando', null)).toMatchObject({ rotulo: 'Qualificando' });
  });
});
