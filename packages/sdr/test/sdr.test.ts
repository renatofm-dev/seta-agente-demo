import { createFakeProvider } from '@seta/ai-provider/testing';
import {
  apresentar,
  type ContextoFluxo,
  type CotaDisponivel,
  type EstadoFluxo,
  formatarReais,
  iniciar,
  interpretarResposta,
  MAX_NAO_ENTENDI,
  parsearResposta,
  pisoCentavos,
  selecionarOpcoes,
  TEXTO_AGENDAMENTO,
  TEXTO_JA_NO_PISO,
  TEXTO_NAO_ENTENDI,
  TEXTO_QUALIFICACAO_PERIODOS,
  TEXTO_QUALIFICACAO_PESSOAS,
  TEXTO_SEM_ESTOQUE,
  TEXTO_SEM_INTERESSE,
  TEXTOS_FIXOS,
  textoAgendado,
  textoAlcada,
  textoLimiteDia,
  textoLista,
  textoOfertaPiso,
  textoOfertaTabela,
  transicionar,
  valorDoTexto,
} from '@seta/sdr';
import { describe, expect, it } from 'vitest';

const cota = (p: Partial<CotaDisponivel> & Pick<CotaDisponivel, 'cotaId'>): CotaDisponivel => ({
  cotaCodigo: `C-${p.cotaId}`,
  bloco: 'TORRE 1',
  andar: 5,
  uh: '501',
  capacidade: 6,
  tier: 'DIAMANTE PREMIUM',
  modelo: 'USO ANUAL 2 PERIODOS',
  periodos: 2,
  valorTabelaCentavos: 20_825_000,
  ...p,
});

/** Estoque no formato do seed: tier×modelo repetidos, capacidades variadas. */
const COTAS: CotaDisponivel[] = [
  cota({ cotaId: '1', cotaCodigo: 'C501-133', capacidade: 8 }),
  cota({ cotaId: '2', cotaCodigo: 'C102-122', capacidade: 4 }), // mesmo tier×modelo da 1
  cota({
    cotaId: '3',
    cotaCodigo: 'C203-036',
    capacidade: 8,
    tier: 'DIAMANTE MASTER',
    valorTabelaCentavos: 16_800_000,
  }),
  cota({
    cotaId: '4',
    cotaCodigo: 'C301-010',
    capacidade: 4,
    tier: 'OURO SPECIAL',
    valorTabelaCentavos: 6_825_000,
  }),
  cota({
    cotaId: '5',
    cotaCodigo: 'C401-100',
    capacidade: 6,
    modelo: 'USO ANUAL 3 PERIODOS',
    periodos: 3,
    valorTabelaCentavos: 28_560_000,
  }),
];
const CTX: ContextoFluxo = { descontoMaxBps: 300, maxPropostasDia: 3, propostasHoje: 0 };

/** Estado na etapa de oferta (tabela) com a DIAMANTE PREMIUM escolhida. */
function estadoOferta(): EstadoFluxo {
  const opcoes = selecionarOpcoes(COTAS, { pessoas: 4, periodos: 2 });
  return {
    etapa: 'oferta',
    perfil: { pessoas: 4, periodos: 2, contato: null },
    opcoes,
    escolha: 2, // DIAMANTE PREMIUM (a mais cara das 3)
    oferta: 'tabela',
    naoEntendi: 0,
    encerramento: null,
  };
}

describe('piso da alçada', () => {
  it('aritmética inteira, mesma fórmula do SQL (divisão inteira de positivo = floor)', () => {
    expect(pisoCentavos(20_825_000, 300)).toBe(20_200_250);
    expect(pisoCentavos(2_340_000, 300)).toBe(2_269_800);
    expect(pisoCentavos(999_999, 300)).toBe(969_999);
    expect(pisoCentavos(100, 0)).toBe(100);
  });
  it('rejeita float e bps fora de 0..10000', () => {
    expect(() => pisoCentavos(100.5, 300)).toThrow();
    expect(() => pisoCentavos(100, 10_001)).toThrow();
    expect(() => pisoCentavos(-1, 300)).toThrow();
  });
});

describe('selecionarOpcoes', () => {
  it('filtra por capacidade e períodos, uma por tier×modelo, mais baratas primeiro, até 3', () => {
    const op = selecionarOpcoes(COTAS, { pessoas: 4, periodos: 2 });
    expect(op.map((c) => c.cotaCodigo)).toEqual(['C301-010', 'C203-036', 'C501-133']);
  });
  it('capacidade corta; períodos corta', () => {
    expect(selecionarOpcoes(COTAS, { pessoas: 6, periodos: 2 }).map((c) => c.cotaCodigo)).toEqual([
      'C203-036',
      'C501-133',
    ]);
    expect(selecionarOpcoes(COTAS, { pessoas: 2, periodos: 3 }).map((c) => c.cotaCodigo)).toEqual([
      'C401-100',
    ]);
    expect(selecionarOpcoes(COTAS, { pessoas: 10, periodos: 2 })).toEqual([]);
  });
});

describe('máquina de estados do SDR', () => {
  it('caminho feliz: qualifica → busca estoque → lista → tabela → piso → aceita → agenda', () => {
    const t0 = iniciar(CTX);
    expect(t0.estado.etapa).toBe('qualificacao');
    expect(t0.mensagens).toEqual([TEXTO_QUALIFICACAO_PESSOAS]);

    const t1 = transicionar(t0.estado, { tipo: 'pessoas', n: 4 }, CTX);
    expect(t1.mensagens).toEqual([TEXTO_QUALIFICACAO_PERIODOS]);

    const t2 = transicionar(t1.estado, { tipo: 'periodos', n: 2 }, CTX);
    expect(t2.efeito).toBe('buscar_estoque');
    expect(t2.mensagens).toEqual([]);

    const t3 = apresentar(t2.estado, COTAS);
    expect(t3.estado.etapa).toBe('apresentacao');
    expect(t3.estado.opcoes).toHaveLength(3);
    expect(t3.mensagens[0]).toContain('1) Ouro Special');
    expect(t3.mensagens[0]).toContain('R$ 68.250,00');
    expect(t3.mensagens[0]).toContain('3) Diamante Premium');

    const t4 = transicionar(t3.estado, { tipo: 'escolher', indice: 3 }, CTX);
    expect(t4.estado).toMatchObject({ etapa: 'oferta', escolha: 2, oferta: 'tabela' });
    expect(t4.efeito).toBe('ofertar');
    expect(t4.mensagens[0]).toContain('R$ 208.250,00 à vista');

    const t5 = transicionar(t4.estado, { tipo: 'pedir_melhor' }, CTX);
    expect(t5.estado.oferta).toBe('piso');
    expect(t5.efeito).toBe('ofertar');
    expect(t5.mensagens[0]).toContain('R$ 202.002,50');

    // já no piso: não há mais para onde ir
    const t6 = transicionar(t5.estado, { tipo: 'pedir_melhor' }, CTX);
    expect(t6.mensagens).toEqual([TEXTO_JA_NO_PISO]);
    expect(t6.efeito).toBe('nenhum');

    const t7 = transicionar(t6.estado, { tipo: 'aceitar' }, CTX);
    expect(t7.estado.etapa).toBe('agendamento');
    expect(t7.mensagens).toEqual([TEXTO_AGENDAMENTO]);

    const t8 = transicionar(t7.estado, { tipo: 'agendar', texto: 'Renato, amanhã às 10h' }, CTX);
    expect(t8.estado).toMatchObject({ etapa: 'encerrado', encerramento: 'agendado' });
    expect(t8.estado.perfil.contato).toBe('Renato, amanhã às 10h');
    expect(t8.efeito).toBe('agendar');
    expect(t8.mensagens[0]).toContain('Renato, amanhã às 10h');
  });

  it('pedido de valor: acima do vigente aceita; dentro da faixa vai para o piso; abaixo do piso escala', () => {
    const e = estadoOferta();
    // pediu mais do que a tabela: aceite pelo valor vigente
    expect(transicionar(e, { tipo: 'pedir_valor', centavos: 21_000_000 }, CTX).estado.etapa).toBe(
      'agendamento',
    );
    // dentro da faixa (−1,5%): só ofertamos pontos discretos ⇒ piso
    const dentro = transicionar(e, { tipo: 'pedir_valor', centavos: 20_500_000 }, CTX);
    expect(dentro.estado.oferta).toBe('piso');
    expect(dentro.efeito).toBe('ofertar');
    // abaixo do piso: escala com o valor pedido
    const abaixo = transicionar(e, { tipo: 'pedir_valor', centavos: 10_000_000 }, CTX);
    expect(abaixo.estado).toMatchObject({
      etapa: 'encerrado',
      encerramento: 'aguardando_aprovacao',
    });
    expect(abaixo.efeito).toBe('escalar_alcada');
    expect(abaixo.valorPedidoCentavos).toBe(10_000_000);
    expect(abaixo.mensagens[0]).toContain('R$ 100.000,00 passa da minha alçada');
    // no piso, pedir igual ao piso = aceitar
    const noPiso = { ...e, oferta: 'piso' as const };
    expect(
      transicionar(noPiso, { tipo: 'pedir_valor', centavos: 20_200_250 }, CTX).estado.etapa,
    ).toBe('agendamento');
  });

  it('sem estoque para o perfil ⇒ encerra e escala para o comercial', () => {
    const t = apresentar(
      { ...iniciar(CTX).estado, perfil: { pessoas: 10, periodos: 2, contato: null } },
      COTAS,
    );
    expect(t.estado).toMatchObject({ etapa: 'encerrado', encerramento: 'sem_estoque' });
    expect(t.efeito).toBe('escalar_sem_estoque');
    expect(t.mensagens).toEqual([TEXTO_SEM_ESTOQUE]);
  });

  it('limite diário de propostas ⇒ nem começa', () => {
    const t = iniciar({ ...CTX, propostasHoje: 3 });
    expect(t.estado.encerramento).toBe('limite_dia');
    expect(t.efeito).toBe('escalar_limite');
    expect(t.mensagens).toEqual([textoLimiteDia(3)]);
  });

  it('cancelar em qualquer etapa ⇒ sem_interesse; 2× não entendi ⇒ abandonado em silêncio', () => {
    const e = estadoOferta();
    const c = transicionar(e, { tipo: 'cancelar' }, CTX);
    expect(c.estado.encerramento).toBe('sem_interesse');
    expect(c.mensagens).toEqual([TEXTO_SEM_INTERESSE]);

    const n1 = transicionar(e, { tipo: 'nao_entendi' }, CTX);
    expect(n1.mensagens).toEqual([TEXTO_NAO_ENTENDI]);
    const n2 = transicionar(n1.estado, { tipo: 'nao_entendi' }, CTX);
    expect(n2.estado.encerramento).toBe('abandonado');
    expect(n2.mensagens).toEqual([]);
    expect(MAX_NAO_ENTENDI).toBe(2);
  });

  it('pessoas fora de 1..12 e períodos fora de 1..3 não são aceitos', () => {
    const q = iniciar(CTX).estado;
    expect(transicionar(q, { tipo: 'pessoas', n: 40 }, CTX).mensagens).toEqual([TEXTO_NAO_ENTENDI]);
    const comPessoas = transicionar(q, { tipo: 'pessoas', n: 2 }, CTX).estado;
    expect(transicionar(comPessoas, { tipo: 'periodos', n: 7 }, CTX).mensagens).toEqual([
      TEXTO_NAO_ENTENDI,
    ]);
  });
});

describe('parser determinístico', () => {
  const q = iniciar(CTX).estado;
  const qComPessoas = { ...q, perfil: { ...q.perfil, pessoas: 4 } };
  const lista = apresentar(
    { ...q, perfil: { pessoas: 4, periodos: 2, contato: null } },
    COTAS,
  ).estado;
  const oferta = estadoOferta();
  const agendamento: EstadoFluxo = { ...oferta, etapa: 'agendamento' };

  it('qualificação: número em dígito ou por extenso; sozinho/casal', () => {
    expect(parsearResposta('somos 4', q)).toEqual({ tipo: 'pessoas', n: 4 });
    expect(parsearResposta('quatro pessoas', q)).toEqual({ tipo: 'pessoas', n: 4 });
    expect(parsearResposta('sozinho', q)).toEqual({ tipo: 'pessoas', n: 1 });
    expect(parsearResposta('vamos em casal', q)).toEqual({ tipo: 'pessoas', n: 2 });
    expect(parsearResposta('2 vezes', qComPessoas)).toEqual({ tipo: 'periodos', n: 2 });
    expect(parsearResposta('duas vezes por ano', qComPessoas)).toEqual({ tipo: 'periodos', n: 2 });
    expect(parsearResposta('depende', q)).toBeNull();
  });

  it('apresentação: número, ordinal, "a mais barata"; fora da lista ⇒ null', () => {
    expect(parsearResposta('2', lista)).toEqual({ tipo: 'escolher', indice: 2 });
    expect(parsearResposta('a segunda', lista)).toEqual({ tipo: 'escolher', indice: 2 });
    expect(parsearResposta('a mais barata', lista)).toEqual({ tipo: 'escolher', indice: 1 });
    expect(parsearResposta('5', lista)).toBeNull();
  });

  it('oferta: aceite, pedido de valor (mil / R$ / k) e pedido de melhor', () => {
    expect(parsearResposta('fechado', oferta)).toEqual({ tipo: 'aceitar' });
    expect(parsearResposta('👍', oferta)).toEqual({ tipo: 'aceitar' });
    expect(parsearResposta('fecho por 180 mil', oferta)).toEqual({
      tipo: 'pedir_valor',
      centavos: 18_000_000,
    });
    expect(parsearResposta('R$ 200.000,00', oferta)).toEqual({
      tipo: 'pedir_valor',
      centavos: 20_000_000,
    });
    expect(parsearResposta('pago 195k', oferta)).toEqual({
      tipo: 'pedir_valor',
      centavos: 19_500_000,
    });
    expect(parsearResposta('consegue melhorar?', oferta)).toEqual({ tipo: 'pedir_melhor' });
    expect(parsearResposta('tá caro demais', oferta)).toEqual({ tipo: 'pedir_melhor' });
    expect(parsearResposta('hmm', oferta)).toBeNull();
  });

  it('valorDoTexto nunca lê número pequeno como dinheiro', () => {
    expect(valorDoTexto('2')).toBeNull();
    expect(valorDoTexto('quero a 3')).toBeNull();
    expect(valorDoTexto('1000')).toBe(100_000);
  });

  it('cancelar em qualquer etapa; agendamento aceita texto livre', () => {
    expect(parsearResposta('não tenho interesse', oferta)).toEqual({ tipo: 'cancelar' });
    expect(parsearResposta('só olhando', q)).toEqual({ tipo: 'cancelar' });
    expect(parsearResposta('Renato, amanhã às 10h', agendamento)).toEqual({
      tipo: 'agendar',
      texto: 'Renato, amanhã às 10h',
    });
  });
});

describe('interpretarResposta (LLM só como fallback)', () => {
  const q = iniciar(CTX).estado;

  it('mapeia JSON válido para a etapa; fora da etapa ⇒ nao_entendi', async () => {
    const fake = createFakeProvider().respondeTexto('{"acao":"pessoas","n":5}');
    expect((await interpretarResposta(fake, q, 'eu, esposa e 3 filhos')).acao).toEqual({
      tipo: 'pessoas',
      n: 5,
    });
    const fora = createFakeProvider().respondeTexto('{"acao":"aceitar"}');
    expect((await interpretarResposta(fora, q, 'ok')).acao).toEqual({ tipo: 'nao_entendi' });
  });

  it('valor em reais vira centavos e só serve na oferta', async () => {
    const fake = createFakeProvider().respondeTexto('{"acao":"pedir_valor","reais":180000}');
    expect((await interpretarResposta(fake, estadoOferta(), 'dá 180?')).acao).toEqual({
      tipo: 'pedir_valor',
      centavos: 18_000_000,
    });
  });

  it('JSON inválido, provider fora ou fila vazia ⇒ nao_entendi, nunca lança', async () => {
    const lixo = createFakeProvider().respondeTexto('sei lá');
    expect((await interpretarResposta(lixo, q, '?')).acao).toEqual({ tipo: 'nao_entendi' });
    const vazio = createFakeProvider(); // fila vazia lança dentro do chat()
    expect((await interpretarResposta(vazio, q, '?')).acao).toEqual({ tipo: 'nao_entendi' });
  });
});

describe('vocabulário dos textos (guardrail de preço)', () => {
  const PROIBIDO =
    /\d+\s?%|por\s?cento|\b(desconto|abatimento|cortesia|por conta da casa|pre[cç]o especial|condi[cç][aã]o especial|baixar o pre[cç]o|fa[cç]o por)\b/i;
  it('nenhum texto do SDR contém percentual nem o vocabulário que o guardrail barra', () => {
    const e = estadoOferta();
    const todos = [
      ...TEXTOS_FIXOS,
      textoLista(e),
      textoOfertaTabela(e),
      textoOfertaPiso(e, 300),
      textoAlcada(10_000_000),
      textoAgendado({ contato: 'Renato, 10h' }),
      textoLimiteDia(3),
    ];
    for (const t of todos) expect(t, t).not.toMatch(PROIBIDO);
    expect(formatarReais(20_200_250)).toBe('R$ 202.002,50');
  });
});
