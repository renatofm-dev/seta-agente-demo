import { createFakeProvider } from '@seta/ai-provider/testing';
import { describe, expect, it } from 'vitest';
import {
  apresentarHoteis,
  apresentarSimulacao,
  apresentarTiposUh,
  type ContextoFluxo,
  cpfValido,
  type EstadoFluxo,
  extrairCpf,
  extrairPagantes,
  extrairPeriodo,
  iniciar,
  interpretarResposta,
  parsearResposta,
  type SimulacaoReserva,
  TEXTO_BLOQUEADO,
  TEXTO_CANCELADO,
  TEXTO_NAO_ENTENDI,
  TEXTO_PAGANTES,
  TEXTO_PERIODO,
  transicionar,
} from '../src/index.ts';

/** "hoje" fixo: as datas relativas do parser não podem depender do calendário. */
const HOJE = new Date('2027-03-01T12:00:00Z');

const CTX: ContextoFluxo = {
  contratoStatus: 'ativo',
  distratoEmAnalise: false,
  saldoPontos: 66_000,
  tetoTaxaCentavos: 100_000,
  titular: { nome: 'BRUNO FERREIRA', cpf: '53022628277' },
};

const HOTEIS = [
  { id: 1, descricao: 'TORRE 1' },
  { id: 2, descricao: 'TORRE 2' },
];
const TIPOS = [
  { id: 1, descricao: 'STANDARD' },
  { id: 2, descricao: 'SUPERIOR' },
];

const simulacao = (over: Partial<SimulacaoReserva> = {}): SimulacaoReserva => ({
  diarias: [
    {
      dia: '2027-05-10',
      bloqueado: false,
      periodo: 'PADRÃO',
      custoPontos: 1000,
      taxaCentavos: 11_000,
    },
    {
      dia: '2027-05-11',
      bloqueado: false,
      periodo: 'PADRÃO',
      custoPontos: 1000,
      taxaCentavos: 11_000,
    },
    {
      dia: '2027-05-12',
      bloqueado: false,
      periodo: 'PADRÃO',
      custoPontos: 1000,
      taxaCentavos: 11_000,
    },
  ],
  custoPontos: 3000,
  taxaCentavos: 33_000,
  bloqueadas: [],
  ...over,
});

/** Estados encadeados pela PRÓPRIA máquina — nunca literais escritos à mão. */
function ate(etapa: EstadoFluxo['etapa'], ctx: ContextoFluxo = CTX): EstadoFluxo {
  let e = iniciar(ctx).estado;
  if (etapa === 'periodo') return e;
  e = transicionar(
    e,
    { tipo: 'periodo', checkIn: '2027-05-10', checkOut: '2027-05-13' },
    ctx,
  ).estado;
  e = apresentarHoteis(e, HOTEIS).estado;
  if (etapa === 'hotel') return e;
  e = transicionar(e, { tipo: 'escolher', indice: 1 }, ctx).estado;
  e = apresentarTiposUh(e, TIPOS).estado;
  if (etapa === 'unidade') return e;
  e = transicionar(e, { tipo: 'escolher', indice: 2 }, ctx).estado;
  if (etapa === 'pagantes') return e;
  e = transicionar(e, { tipo: 'pagantes', adultos: 2, criancas: 0 }, ctx).estado;
  e = apresentarSimulacao(e, simulacao(), ctx).estado;
  if (etapa === 'hospedes') return e;
  e = transicionar(
    e,
    { tipo: 'hospede', nome: 'CICRANA', sobrenome: 'DE TAL', cpf: '00029865310' },
    ctx,
  ).estado;
  return e;
}

describe('CPF: o parser é o guardião', () => {
  /**
   * O caso nomeado que a spec exige. O decorator de anonimização troca CPF por
   * token no que vai para a LLM e destokeniza na volta, mas token DESCONHECIDO
   * passa intacto — e `[CPF_1]` gravado no ERP é dado errado num sistema de
   * terceiro. Por isso o CPF só nasce aqui, do texto cru.
   */
  it('token de anonimização NUNCA vira CPF', () => {
    expect(extrairCpf('o CPF dela é [CPF_1]')).toBeNull();
    expect(extrairCpf('[CPF_1] 000.298.653-10')).toBeNull();
  });

  it('CPF com DV inválido é recusado', () => {
    expect(cpfValido('111.111.111-11')).toBeNull();
    expect(cpfValido('000.298.653-11')).toBeNull();
    expect(cpfValido('123')).toBeNull();
  });

  it('CPF válido sai só com os dígitos, com ou sem máscara', () => {
    expect(extrairCpf('CPF 000.298.653-10')).toBe('00029865310');
    expect(extrairCpf('cpf 00029865310 obrigado')).toBe('00029865310');
  });

  it('o schema do fallback por LLM não tem onde escrever um CPF', async () => {
    const fake = createFakeProvider().respondeTexto(
      '{"acao":"hospede","cpf":"[CPF_1]","nome":"X"}',
    );
    const r = await interpretarResposta(fake, ate('hospedes'), 'o cpf é [CPF_1]');
    expect(r.acao).toEqual({ tipo: 'nao_entendi' });
  });

  it('na etapa de hóspedes, nome sai do texto e o token não vira documento', () => {
    const acao = parsearResposta('o nome é Maria Souza, CPF [CPF_1]', ate('hospedes'), HOJE);
    expect(acao).toMatchObject({ tipo: 'hospede', cpf: null });
    expect((acao as { nome: string }).nome).toBe('Maria');
  });
});

describe('parser determinístico', () => {
  it('lê o período em barra, por extenso e ISO', () => {
    expect(extrairPeriodo('de 10/05 a 13/05', HOJE)).toEqual({
      checkIn: '2027-05-10',
      checkOut: '2027-05-13',
    });
    expect(extrairPeriodo('de 10 a 13 de maio', HOJE)).toEqual({
      checkIn: '2027-05-10',
      checkOut: '2027-05-13',
    });
    expect(extrairPeriodo('2027-05-10 até 2027-05-13', HOJE)).toEqual({
      checkIn: '2027-05-10',
      checkOut: '2027-05-13',
    });
  });

  it('data já passada no ano cai no ano seguinte', () => {
    expect(extrairPeriodo('de 10 a 13 de janeiro', HOJE)?.checkIn).toBe('2028-01-10');
  });

  it('lê a lotação em dígito e por extenso', () => {
    expect(extrairPagantes('2 adultos e 1 criança')).toEqual({ adultos: 2, criancas: 1 });
    expect(extrairPagantes('duas pessoas')).toEqual({ adultos: 2, criancas: 0 });
    expect(extrairPagantes('somos 4')).toEqual({ adultos: 4, criancas: 0 });
  });

  it('escolhe hotel por número OU pelo nome mostrado', () => {
    const e = ate('hotel');
    expect(parsearResposta('2', e, HOJE)).toEqual({ tipo: 'escolher', indice: 2 });
    expect(parsearResposta('quero a torre 2', e, HOJE)).toEqual({ tipo: 'escolher', indice: 2 });
  });

  it('cancelar vale em qualquer etapa; em dúvida devolve null', () => {
    expect(parsearResposta('deixa pra lá', ate('pagantes'), HOJE)).toEqual({ tipo: 'cancelar' });
    expect(parsearResposta('sei lá', ate('periodo'), HOJE)).toBeNull();
  });

  it('confirma com sim, ok e 👍', () => {
    const e = ate('confirmacao');
    for (const t of ['sim', 'pode confirmar', 'ok', '👍']) {
      expect(parsearResposta(t, e, HOJE), t).toEqual({ tipo: 'confirmar' });
    }
  });
});

describe('máquina: o caminho feliz', () => {
  it('sai do período e vai buscar hotéis no ERP', () => {
    const t = transicionar(
      iniciar(CTX).estado,
      { tipo: 'periodo', checkIn: '2027-05-10', checkOut: '2027-05-13' },
      CTX,
    );
    expect(t.efeito).toBe('buscar_hoteis');
    expect(t.estado.etapa).toBe('hotel');
  });

  it('um hotel só não vira pergunta', () => {
    const e = transicionar(
      iniciar(CTX).estado,
      { tipo: 'periodo', checkIn: '2027-05-10', checkOut: '2027-05-13' },
      CTX,
    ).estado;
    const t = apresentarHoteis(e, [{ id: 7, descricao: 'TORRE ÚNICA' }]);
    expect(t.estado.idHotel).toBe(7);
    expect(t.efeito).toBe('buscar_tipos_uh');
  });

  it('a lotação dispara a SIMULAÇÃO, antes de qualquer CPF', () => {
    const t = transicionar(ate('pagantes'), { tipo: 'pagantes', adultos: 2, criancas: 0 }, CTX);
    expect(t.efeito).toBe('simular');
    expect(t.estado.hospedes).toHaveLength(0);
  });

  it('o titular entra como hóspede principal com o CPF do cadastro', () => {
    const t = apresentarSimulacao(
      transicionar(ate('pagantes'), { tipo: 'pagantes', adultos: 2, criancas: 0 }, CTX).estado,
      simulacao(),
      CTX,
    );
    expect(t.estado.hospedes[0]).toMatchObject({
      nome: 'BRUNO FERREIRA',
      cpf: '53022628277',
      principal: true,
    });
    expect(t.mensagens[0]).toContain('Pontos: 3.000');
  });

  it('confirmado dentro do teto, o efeito é criar', () => {
    const t = transicionar(ate('confirmacao'), { tipo: 'confirmar' }, CTX);
    expect(t.efeito).toBe('criar');
    expect(t.estado.encerramento).toBe('criando');
  });

  it('taxa acima do teto espera aprovação humana', () => {
    const ctx = { ...CTX, tetoTaxaCentavos: 10_000 };
    const t = transicionar(ate('confirmacao', ctx), { tipo: 'confirmar' }, ctx);
    expect(t.efeito).toBe('criar_com_aprovacao');
    expect(t.estado.encerramento).toBe('aguardando_aprovacao');
    expect(t.mensagens[0]).toContain('R$');
  });
});

describe('máquina: quando não dá', () => {
  it('período bloqueado encerra citando os dias do ERP, sem oferecer alternativa inventada', () => {
    const t = apresentarSimulacao(ate('hospedes'), simulacao({ bloqueadas: ['2027-05-11'] }), CTX);
    expect(t.estado.encerramento).toBe('periodo_bloqueado');
    expect(t.mensagens[0]).toContain('11/05');
  });

  it('pontos insuficientes encerram com o número do contrato', () => {
    const t = apresentarSimulacao(ate('hospedes'), simulacao(), { ...CTX, saldoPontos: 500 });
    expect(t.estado.encerramento).toBe('pontos_insuficientes');
    expect(t.mensagens[0]).toContain('500');
  });

  it('contrato cancelado nem começa — escala', () => {
    const t = iniciar({ ...CTX, contratoStatus: 'cancelado' });
    expect(t.efeito).toBe('escalar_bloqueio');
    expect(t.mensagens).toEqual([TEXTO_BLOQUEADO]);
  });

  it('distrato em análise idem', () => {
    expect(iniciar({ ...CTX, distratoEmAnalise: true }).efeito).toBe('escalar_bloqueio');
  });

  it('sem hotel disponível, escala em vez de inventar', () => {
    const t = apresentarHoteis(ate('hotel'), []);
    expect(t.estado.encerramento).toBe('sem_hoteis');
    expect(t.efeito).toBe('escalar_bloqueio');
  });

  it('duas incompreensões seguidas e o fluxo sai da frente, em silêncio', () => {
    const um = transicionar(ate('pagantes'), { tipo: 'nao_entendi' }, CTX);
    expect(um.mensagens).toEqual([TEXTO_NAO_ENTENDI]);
    const dois = transicionar(um.estado, { tipo: 'nao_entendi' }, CTX);
    expect(dois.estado.encerramento).toBe('abandonado');
    expect(dois.mensagens).toEqual([]);
  });

  it('ação válida zera o contador de incompreensão', () => {
    const um = transicionar(ate('pagantes'), { tipo: 'nao_entendi' }, CTX).estado;
    expect(
      transicionar(um, { tipo: 'pagantes', adultos: 2, criancas: 0 }, CTX).estado.naoEntendi,
    ).toBe(0);
  });

  it('cancelar encerra em qualquer etapa', () => {
    for (const etapa of ['periodo', 'hotel', 'pagantes', 'confirmacao'] as const) {
      const t = transicionar(ate(etapa), { tipo: 'cancelar' }, CTX);
      expect(t.estado.encerramento, etapa).toBe('cancelado');
      expect(t.mensagens).toEqual([TEXTO_CANCELADO]);
    }
  });

  it('fluxo encerrado é no-op', () => {
    const fim = transicionar(ate('confirmacao'), { tipo: 'cancelar' }, CTX).estado;
    expect(transicionar(fim, { tipo: 'confirmar' }, CTX).mensagens).toEqual([]);
  });
});

describe('fallback por LLM', () => {
  it('só é chamado quando o parser desiste, e revalida contra a etapa', async () => {
    const fake = createFakeProvider().respondeTexto('{"acao":"confirmar"}');
    const r = await interpretarResposta(fake, ate('pagantes'), 'pode ser');
    // confirmar fora da confirmação não confirma nada
    expect(r.acao).toEqual({ tipo: 'nao_entendi' });
  });

  it('índice fora da lista vira nao_entendi', async () => {
    const fake = createFakeProvider().respondeTexto('{"acao":"escolher","indice":9}');
    const r = await interpretarResposta(fake, ate('hotel'), 'o nono');
    expect(r.acao).toEqual({ tipo: 'nao_entendi' });
  });

  it('modelo fora do ar não trava o fluxo', async () => {
    const fake = createFakeProvider(); // fila vazia: o provider lança
    const r = await interpretarResposta(fake, ate('hotel'), 'sei lá');
    expect(r.acao).toEqual({ tipo: 'nao_entendi' });
    expect(r.tokensEntrada).toBe(0);
  });

  it('o prompt mostra ao modelo as MESMAS opções que o cotista viu', async () => {
    const fake = createFakeProvider().respondeTexto('{"acao":"escolher","indice":2}');
    await interpretarResposta(fake, ate('hotel'), 'a segunda');
    expect(fake.requests[0]?.messages[0]?.content).toContain('2. TORRE 2');
  });
});

describe('textos', () => {
  it('a primeira pergunta é o período', () => {
    expect(iniciar(CTX).mensagens).toEqual([TEXTO_PERIODO]);
  });

  it('escolhida a unidade, pergunta a lotação', () => {
    const t = transicionar(ate('unidade'), { tipo: 'escolher', indice: 2 }, CTX);
    expect(t.mensagens).toEqual([TEXTO_PAGANTES]);
  });

  it('a confirmação mostra pontos e taxa vindos da simulação', () => {
    // fecha a lista de hóspedes: o titular já entrou, falta o acompanhante
    const t = transicionar(
      ate('hospedes'),
      { tipo: 'hospede', nome: 'CICRANA', sobrenome: 'DE TAL', cpf: '00029865310' },
      CTX,
    );
    expect(t.estado.etapa).toBe('confirmacao');
    const texto = t.mensagens[0] ?? '';
    expect(texto).toContain('R$ 330,00');
    expect(texto).toContain('SUPERIOR');
    expect(texto).toContain('CICRANA');
  });
});
