import { describe, expect, it } from 'vitest';
import {
  createErpSimulado,
  createTseErpApi,
  ErpBusinessError,
  mesmaReserva,
  paraSimulacao,
  type UtilizacaoErp,
} from '../src/index.ts';
import { criarFakeTse, fixture } from './fake-tse.ts';

/**
 * O adapter de reserva contra os exemplos REAIS do fornecedor (fixtures da 035).
 * O que se prova aqui: entendemos a simulação diária a diária, o dinheiro entra
 * em centavos inteiros, e "200 com prosa" continua não sendo prova de sucesso.
 */

const CONFIG = { baseUrl: 'http://tse.local', username: 'u', password: 'p' };
const SIMULAR = 'GET /api/utilizacaocontrato/SimularUtilizacaoContrato';
const CRIAR = 'POST /api/utilizacaocontrato/CriarUtilizacaoContrato';
const CONFIRMAR = 'POST /api/utilizacaocontrato/ConfirmarUtilizacaoContrato/26';

const api = (fake: ReturnType<typeof criarFakeTse>) =>
  createTseErpApi({ ...CONFIG, fetchFn: fake.fetchFn, esperar: async () => {} });

const PEDIDO = {
  contratoId: '10001',
  idHotel: 1,
  idTipoUh: 1,
  checkIn: '2027-05-10',
  checkOut: '2027-05-13',
  pagantes: 2,
};

describe('simularUtilizacao', () => {
  it('lê a simulação diária a diária do exemplo do fornecedor', async () => {
    const fake = criarFakeTse();
    fake.responder(SIMULAR, { body: fixture('contract-usase__simulate-contract-usage').body });

    const s = await api(fake).simularUtilizacao(PEDIDO);

    expect(s.diarias).toHaveLength(3);
    expect(s.diarias[0]).toMatchObject({ dia: '2021-04-29', bloqueado: false, periodo: 'PADRÃO' });
    expect(s.custoPontos).toBe(3000);
  });

  it('a taxa vira CENTAVOS inteiros na fronteira — o TSE fala decimal', () => {
    const s = paraSimulacao([
      {
        DataDiaria: '2027-05-10T00:00:00-03:00',
        Bloqueado: false,
        DescricaoPeriodo: 'PADRÃO',
        CustoPorDiaria: 800,
        ValorTaxaPeriodo: 90.55,
      },
    ]);
    expect(s.taxaCentavos).toBe(9055);
    expect(Number.isInteger(s.taxaCentavos)).toBe(true);
  });

  it('diária bloqueada é devolvida nomeada — é com ela que o agente explica', () => {
    const s = paraSimulacao([
      {
        DataDiaria: '2027-01-10T00:00:00-03:00',
        Bloqueado: true,
        DescricaoPeriodo: 'ALTA',
        CustoPorDiaria: 2200,
        ValorTaxaPeriodo: 220,
      },
    ]);
    expect(s.bloqueadas).toEqual(['2027-01-10']);
  });

  /** GET com query string: a coleção salvou GET com BODY, que o Node recusa. */
  it('vai como GET com query, e manda vazios os quatro campos que a coleção manda vazios', async () => {
    const fake = criarFakeTse();
    fake.responder(SIMULAR, { body: [] });

    await api(fake).simularUtilizacao(PEDIDO);

    const url = new URL(fake.chamadas.at(-1)?.url as string);
    expect(url.searchParams.get('IdContrato')).toBe('10001');
    expect(url.searchParams.get('DataInicial')).toBe('2027-05-10');
    for (const vazio of ['cortesia', 'identificadorcortesia', 'blockcode', 'marketcode']) {
      expect(url.searchParams.get(vazio)).toBe('');
    }
  });
});

describe('criarUtilizacao', () => {
  it('manda os hóspedes INLINE — criar + hóspedes é UMA escrita, não 1+N', async () => {
    const fake = criarFakeTse();
    fake.responder(CRIAR, { body: fixture('contract-usase__create-contract-usage').body });

    const u = await api(fake).criarUtilizacao({
      ...PEDIDO,
      adultos: 2,
      criancas: 0,
      hospedes: [
        { nome: 'FULANO', sobrenome: 'DE TAL', cpf: '00015278514', principal: true },
        { nome: 'CICRANA', sobrenome: 'DE TAL', cpf: '00029865310' },
      ],
    });

    const enviado = fake.chamadas.at(-1)?.body as { ListaHospedes: unknown[] };
    expect(enviado.ListaHospedes).toHaveLength(2);
    expect(enviado.ListaHospedes[0]).toMatchObject({ Cpf: '00015278514', HospedePrincipal: true });
    expect(u.id).toBe('26');
    expect(u.custoPontos).toBe(3000);
    expect(u.taxaCentavos).toBe(139_202);
  });

  it('sem CPF o hóspede vai com null — o TSE pede `Sexo` e não temos o dado', async () => {
    const fake = criarFakeTse();
    fake.responder(CRIAR, { body: fixture('contract-usase__create-contract-usage').body });

    await api(fake).criarUtilizacao({
      ...PEDIDO,
      adultos: 1,
      hospedes: [{ nome: 'FULANO' }],
    });

    expect(
      (fake.chamadas.at(-1)?.body as { ListaHospedes: unknown[] }).ListaHospedes[0],
    ).toMatchObject({ Cpf: null, Sexo: null, Sobrenome: null });
  });
});

describe('confirmarUtilizacao', () => {
  it('aceita a prosa do fornecedor', async () => {
    const fake = criarFakeTse();
    fake.responder(CONFIRMAR, { body: fixture('contract-usase__confirm-contract-usage').body });

    await expect(api(fake).confirmarUtilizacao('26')).resolves.toBeUndefined();
  });

  it('HTTP 200 com prosa inesperada NÃO é confirmação — vira ErpBusinessError', async () => {
    const fake = criarFakeTse();
    fake.responder(CONFIRMAR, { body: 'Utilização em análise.' });

    await expect(api(fake).confirmarUtilizacao('26')).rejects.toBeInstanceOf(ErpBusinessError);
  });
});

describe('mesmaReserva — a chave natural do read-back', () => {
  /**
   * `CriarUtilizacaoContrato` não tem campo de referência externa (a 036 pôde
   * usar `CodigoAutorizacao`); é por esta combinação que o worker reconhece a
   * própria escrita quando a resposta se perde.
   */
  const alvo = {
    checkIn: '2027-05-10',
    checkOut: '2027-05-13',
    idHotel: 1,
    idTipoUh: 2,
    pagantes: 2,
  };
  const base: UtilizacaoErp = {
    id: '9',
    status: 'ATIVO',
    confirmada: false,
    custoPontos: 3000,
    taxaCentavos: 33_000,
    checkIn: '2027-05-10',
    checkOut: '2027-05-13',
    hotel: 'TORRE 1',
    tipoUh: 'SUPERIOR',
    idHotel: 1,
    idTipoUh: 2,
    pagantes: 2,
    operador: 'AGENTE.SETA',
  };

  it('reconhece a própria reserva', () => {
    expect(mesmaReserva(base, alvo)).toBe(true);
  });

  it('não confunde com outra semana, outro hotel ou outra lotação', () => {
    expect(mesmaReserva({ ...base, checkOut: '2027-05-14' }, alvo)).toBe(false);
    expect(mesmaReserva({ ...base, idHotel: 2 }, alvo)).toBe(false);
    expect(mesmaReserva({ ...base, pagantes: 3 }, alvo)).toBe(false);
  });

  it('ignora a cancelada — ela não segura pontos nem vaga', () => {
    expect(mesmaReserva({ ...base, status: 'CANCELADA' }, alvo)).toBe(false);
  });
});

describe('ErpWriter simulado', () => {
  it('cria, confirma e lista — e NÃO recusa criação repetida, como o TSE', async () => {
    const sim = createErpSimulado();
    sim.semearReserva({ custoPontosPorDiaria: 800, taxaCentavosPorDiaria: 9_000 });

    const a = await sim.criarUtilizacao({ ...PEDIDO, adultos: 2, hospedes: [] });
    const b = await sim.criarUtilizacao({ ...PEDIDO, adultos: 2, hospedes: [] });
    expect(a.id).not.toBe(b.id);
    expect(a.custoPontos).toBe(2400);

    await sim.confirmarUtilizacao(a.id);
    expect((await sim.lerUtilizacao(a.id))?.confirmada).toBe(true);
    expect(await sim.listarUtilizacoes('10001')).toHaveLength(2);
  });
});
