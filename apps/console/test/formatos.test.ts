import { describe, expect, it } from 'vitest';
import type { MensagemThread } from '../lib/console-api';
import {
  dataCurta,
  estadoJanela,
  horarioLista,
  iniciais,
  mesclarMensagens,
  prefixoSeAplica,
  reaisDeCentavos,
  separadorDia,
  telefoneBonito,
} from '../lib/formatos';

const AGORA = new Date('2026-09-01T15:00:00');

function msg(parcial: Partial<MensagemThread> & { id: string }): MensagemThread {
  return {
    autor: 'contato',
    atendenteId: null,
    atendenteNome: null,
    texto: 'x',
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
