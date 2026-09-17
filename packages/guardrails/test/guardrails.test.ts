import { createFakeProvider } from '@seta/ai-provider/testing';
import {
  ALLOW,
  classificarIntencao,
  extrairValoresMonetarios,
  type GuardrailCtx,
  guardrailPreco,
  intencaoEscala,
  runBeforeReply,
  runToolHooks,
} from '@seta/guardrails';
import { describe, expect, it } from 'vitest';

const CTX_VAZIO: GuardrailCtx = {
  traceId: '01890a5d-ac96-774b-bcce-b302099a8057',
  textoUsuario: 'quanto custa a cerveja?',
  toolResults: [],
};

const ctxComTools = (rows: Record<string, unknown>[], priceSource = true): GuardrailCtx => ({
  ...CTX_VAZIO,
  toolResults: [{ nome: 'preco_tabela_vigente', priceSource, rows }],
});

describe('extração de valores monetários', () => {
  it('extrai R$ com milhar e centavos', () => {
    expect(extrairValoresMonetarios('custa R$ 1.299,00 e R$ 42,90')).toEqual([129900, 4290]);
    expect(extrairValoresMonetarios('R$118,80')).toEqual([11880]);
    expect(extrairValoresMonetarios('R$ 2854,30')).toEqual([285430]); // sem separador de milhar
    expect(extrairValoresMonetarios('sem valor nenhum')).toEqual([]);
  });
});

describe('guardrail de preço (beforeReply)', () => {
  const g = guardrailPreco();

  it('critério 006: valor não vindo de tool do turno é bloqueado', async () => {
    const v = await g.beforeReply?.('O preço fica R$ 123,45 pra você!', CTX_VAZIO);
    expect(v).toMatchObject({ tipo: 'escalate', trigger: 'negociacao_preco' });
  });

  it('valor rastreável a resultado de tool do turno passa', async () => {
    const ctx = ctxComTools([{ produto_id: '1001', preco_centavos: '12345' }]);
    const v = await g.beforeReply?.('O preço de tabela é R$ 123,45.', ctx);
    expect(v).toEqual(ALLOW);
  });

  it('promessa de desconto/percentual escala mesmo com valores rastreáveis', async () => {
    const ctx = ctxComTools([{ preco_centavos: '10000' }]);
    expect(await g.beforeReply?.('Te dou 10% de desconto!', ctx)).toMatchObject({
      tipo: 'escalate',
      trigger: 'negociacao_preco',
    });
    expect(await g.beforeReply?.('Consigo um preço especial: R$ 100,00', ctx)).toMatchObject({
      tipo: 'escalate',
    });
  });

  // regressão: a KB de trocas fala em "abatimento do frete"; citar política
  // recuperada por tool no turno não é negociar preço
  const ctxPoliticaTroca: GuardrailCtx = {
    ...CTX_VAZIO,
    textoUsuario: 'como funciona a troca?',
    toolResults: [
      {
        nome: 'buscar_conhecimento',
        priceSource: false,
        rows: [
          {
            fonte: 'Política de trocas e devoluções',
            trecho:
              'Compra errada pelo cliente: a devolução é aceita com abatimento do frete de retorno.',
          },
        ],
      },
    ],
  };

  it('termo comercial citado de política recuperada por tool passa', async () => {
    const draft = 'Pela política, a devolução é aceita com abatimento do frete de retorno.';
    expect(await g.beforeReply?.(draft, ctxPoliticaTroca)).toEqual(ALLOW);
  });

  it('termo comercial sem origem em tool do turno escala', async () => {
    expect(
      await g.beforeReply?.('A empresa costuma dar abatimento nesses casos.', CTX_VAZIO),
    ).toMatchObject({ tipo: 'escalate', trigger: 'negociacao_preco' });
  });

  it('promessa em 1ª pessoa escala mesmo com o termo presente na fonte', async () => {
    expect(
      await g.beforeReply?.('Posso te dar um abatimento especial no frete.', ctxPoliticaTroca),
    ).toMatchObject({ tipo: 'escalate', trigger: 'negociacao_preco' });
  });

  it('draft sem valores nem promessas passa', async () => {
    expect(await g.beforeReply?.('Seu pedido saiu para entrega hoje!', CTX_VAZIO)).toEqual(ALLOW);
  });

  it('valores de boleto rastreáveis por tool não-price_source também passam', async () => {
    const ctx: GuardrailCtx = {
      ...CTX_VAZIO,
      toolResults: [
        { nome: 'titulos_abertos', priceSource: false, rows: [{ valor_centavos: '54900' }] },
      ],
    };
    expect(await g.beforeReply?.('Seu boleto é de R$ 549,00.', ctx)).toEqual(ALLOW);
  });

  it('id/quantidade de tool não-price_source NÃO valida um R$ do draft (coluna não monetária)', async () => {
    const ctx: GuardrailCtx = {
      ...CTX_VAZIO,
      toolResults: [
        // 990 aparece como id de produto — "R$ 9,90" continua órfão
        { nome: 'ultimos_pedidos', priceSource: false, rows: [{ produto_id: 990, qtd: 990 }] },
      ],
    };
    const v = await g.beforeReply?.('Sai por R$ 9,90!', ctx);
    expect(v?.tipo).toBe('escalate');
  });

  it('mesmo número em coluna monetária de price_source valida normalmente', async () => {
    const ctx = ctxComTools([{ preco_centavos: 990 }]);
    expect(await g.beforeReply?.('Sai por R$ 9,90!', ctx)).toEqual(ALLOW);
  });
});

describe('pipeline', () => {
  it('rewrite substitui o draft e o pipeline continua; block encerra', async () => {
    const hooks = [
      {
        nome: 'assinatura',
        beforeReply: async (draft: string) => ({ tipo: 'rewrite' as const, patch: `${draft} 🙂` }),
      },
      {
        nome: 'palavrao',
        beforeReply: async (draft: string) =>
          draft.includes('droga') ? { tipo: 'block' as const, reason: 'linguagem' } : ALLOW,
      },
    ];
    const ok = await runBeforeReply(hooks, 'Tudo certo!', CTX_VAZIO);
    expect(ok.draft).toBe('Tudo certo! 🙂');
    expect(ok.terminal).toBeNull();
    expect(ok.verdicts).toHaveLength(1);

    const bloqueado = await runBeforeReply(hooks, 'Que droga', CTX_VAZIO);
    expect(bloqueado.terminal).toMatchObject({ tipo: 'block', reason: 'linguagem' });
  });

  it('runToolHooks: beforeTool pode bloquear uma call', async () => {
    const hooks = [
      {
        nome: 'sem-perfil',
        beforeTool: async (call: { nome: string }) =>
          call.nome === 'perfil_cliente'
            ? { tipo: 'block' as const, reason: 'tool desabilitada' }
            : ALLOW,
      },
    ];
    const r = await runToolHooks(
      hooks,
      'beforeTool',
      { nome: 'perfil_cliente', params: {} },
      CTX_VAZIO,
    );
    expect(r.terminal).toMatchObject({ tipo: 'block' });
  });
});

describe('classificador de intenção', () => {
  it('mapeia a resposta estruturada do LLM', async () => {
    const fake = createFakeProvider().respondeTexto('negociar_preco');
    const r = await classificarIntencao(fake, 'me dá 10% de desconto?', []);
    expect(r.intencao).toBe('negociar_preco');
    expect(r.tokensEntrada).toBe(10); // #30: usage do provider vem junto
    expect(r.tokensSaida).toBe(5);
    const req = fake.requests[0];
    expect(req?.messages[0]?.content).toContain('negociar_preco');
    expect(req?.maxOutputTokens).toBe(8);
  });

  it('resposta fora do enum cai em outro (classificador nunca trava o fluxo)', async () => {
    const fake = createFakeProvider().respondeTexto('sei lá, talvez preço?');
    expect((await classificarIntencao(fake, 'oi', [])).intencao).toBe('outro');
  });

  it('temas sensíveis da config entram no prompt', async () => {
    const fake = createFakeProvider().respondeTexto('tema_sensivel');
    await classificarIntencao(fake, 'vou acionar meu advogado', ['jurídico', 'imprensa']);
    expect(fake.requests[0]?.messages[0]?.content).toContain('jurídico, imprensa');
  });

  /**
   * 038: sem a categoria `reservar`, "gostaria de realizar uma reserva" era
   * classificada como `comprar_cota` e o turno ESCALAVA para o comercial — o
   * fluxo de reserva nunca começava. Estes casos travam o contrato.
   */
  it('reservar é uma categoria e NÃO escala', async () => {
    const fake = createFakeProvider().respondeTexto('reservar');
    const r = await classificarIntencao(fake, 'gostaria de realizar uma reserva', []);
    expect(r.intencao).toBe('reservar');
    expect(intencaoEscala(r.intencao)).toBe(false);
  });

  it('o prompt distingue usar o contrato de adquirir outra cota', async () => {
    const fake = createFakeProvider().respondeTexto('reservar');
    await classificarIntencao(fake, 'quero marcar minha semana', []);
    const prompt = fake.requests[0]?.messages[0]?.content ?? '';
    // sem as duas âncoras o LLM não tem como separar reserva de compra
    expect(prompt).toContain('reservar');
    expect(prompt).toContain('USAR o contrato');
    expect(prompt).toContain('ADQUIRIR outra cota');
  });

  it('pagar e reservar seguem para os fluxos; comprar_cota ainda escala', () => {
    expect(intencaoEscala('pagar')).toBe(false);
    expect(intencaoEscala('reservar')).toBe(false);
    expect(intencaoEscala('outro')).toBe(false);
    expect(intencaoEscala('comprar_cota')).toBe(true);
    expect(intencaoEscala('tema_sensivel')).toBe(true);
  });
});

describe('#34: valores sem o símbolo R$', () => {
  const g = guardrailPreco();

  it('"1234 reais" órfão escala; com origem monetária passa', async () => {
    const semOrigem = await g.beforeReply?.('Fica 1234 reais no total.', CTX_VAZIO);
    expect(semOrigem?.tipo).toBe('escalate');

    const ctx: GuardrailCtx = {
      ...CTX_VAZIO,
      toolResults: [
        { nome: 'titulos_abertos', priceSource: false, rows: [{ valor_centavos: '123400' }] },
      ],
    };
    expect(await g.beforeReply?.('Fica 1234 reais no total.', ctx)).toEqual(ALLOW);
  });

  it('extrai centavos de "12,50 reais"', () => {
    expect(extrairValoresMonetarios('custa 12,50 reais')).toContain(1250);
  });
});

/**
 * 015: a alçada de desconto do SDR não é código novo — ela EMERGE da invariante
 * do guardrail (todo R$ do draft rastreável a um resultado de tool do turno).
 * Estes testes travam o contrato do qual `packages/sdr` vai depender: se alguém
 * afrouxar o guardrail, a alçada cai junto e isto aqui quebra primeiro.
 */
describe('015: alçada de desconto do SDR', () => {
  const g = guardrailPreco();

  // C501-133 do seed do erp_mock: DIAMANTE PREMIUM, 2 períodos.
  const TABELA = 20_825_000; // R$ 208.250,00
  const DESCONTO_MAX_BPS = 300; // 3% — alçada do SDR
  /** Mesma fórmula da spec 015, aritmética inteira: nada de float em dinheiro. */
  const piso = (tabela: number, bps: number) => Math.floor((tabela * (10_000 - bps)) / 10_000);
  const PISO = piso(TABELA, DESCONTO_MAX_BPS); // 20_200_250 → R$ 202.002,50

  /** O que a tool `condicoes_cota` (price_source) devolve para o turno. */
  const ctxOferta = (): GuardrailCtx => ({
    ...CTX_VAZIO,
    textoUsuario: 'consegue melhorar esse valor?',
    toolResults: [
      {
        nome: 'condicoes_cota',
        priceSource: true,
        rows: [{ valor_tabela_centavos: TABELA, valor_minimo_centavos: PISO }],
      },
    ],
  });

  it('o piso é inteiro e corresponde a 3% exatos da tabela', () => {
    expect(PISO).toBe(20_200_250);
    expect(Number.isInteger(PISO)).toBe(true);
    expect(TABELA - PISO).toBe(624_750); // 3,00% de R$ 208.250,00
  });

  it('oferta na tabela cheia passa', async () => {
    const v = await g.beforeReply?.('A C501-133 está R$ 208.250,00.', ctxOferta());
    expect(v).toEqual(ALLOW);
  });

  it('oferta no piso da alçada (-3%) passa', async () => {
    const v = await g.beforeReply?.('Fecho em R$ 202.002,50 à vista.', ctxOferta());
    expect(v).toEqual(ALLOW);
  });

  it('valor ABAIXO do piso escala — é isto que faz cumprir a alçada', async () => {
    // -4%: dentro do que um LLM tentaria, fora do que o comercial autorizou
    const v = await g.beforeReply?.('Fecho em R$ 199.920,00 à vista.', ctxOferta());
    expect(v).toMatchObject({ tipo: 'escalate', trigger: 'negociacao_preco' });
  });

  it('valor DENTRO da faixa mas não autorizado também escala (conjunto exato, não intervalo)', async () => {
    // -1,5%: entre a tabela e o piso, e ainda assim escala — o guardrail casa
    // por igualdade. Por isso a spec 015 manda ofertar pontos DISCRETOS
    // (tabela ou piso) em vez de fatiar desconto.
    const v = await g.beforeReply?.('Fecho em R$ 205.126,00 à vista.', ctxOferta());
    expect(v).toMatchObject({ tipo: 'escalate' });
  });

  it('dizer o percentual em DÍGITO escala, mesmo com a oferta autorizada no contexto', async () => {
    for (const draft of ['Consigo 3% de desconto pra você.', 'Aplico 3 por cento e fecho.']) {
      expect(await g.beforeReply?.(draft, ctxOferta())).toMatchObject({ tipo: 'escalate' });
    }
  });

  // LACUNA CONHECIDA, travada aqui de propósito: RE_PERCENTUAL exige dígito
  // (/\d+(?:[.,]\d+)?\s?(?:%|por\s?cento)/), então percentual POR EXTENSO passa —
  // em qualquer contexto, inclusive sem tool nenhuma no turno. "aplicar" também
  // não está no RE_CONDICAO_ESPECIAL, então não há segunda rede.
  // O comentário do preco.ts documenta o extenso para VALORES; para PERCENTUAIS
  // não estava documentado. Na raia do cotista o classificador de intenção
  // (negociar_preco) pega antes; na raia do SDR, que negocia, isto é exposição
  // real. Se o RE_PERCENTUAL for corrigido, estes casos passam a escalar e este
  // teste deve ser invertido.
  it('LACUNA: percentual por extenso NÃO é barrado', async () => {
    expect(
      await g.beforeReply?.('Aplico três por cento e fecho em R$ 202.002,50.', ctxOferta()),
    ).toEqual(ALLOW);
    expect(
      await g.beforeReply?.('Consigo aplicar dez por cento pra fechar hoje.', CTX_VAZIO),
    ).toEqual(ALLOW);
  });

  it('"faço por" escala mesmo com valor autorizado — a armadilha do fraseado comercial', async () => {
    // Parece neutro, mas está no RE_CONDICAO_ESPECIAL. Os templates do SDR
    // precisam usar "fecho em R$ X" / "está R$ X".
    const v = await g.beforeReply?.('Faço por R$ 202.002,50.', ctxOferta());
    expect(v).toMatchObject({ tipo: 'escalate', trigger: 'negociacao_preco' });
  });

  it('sem a tool de condições no turno, NENHUM valor de oferta passa', async () => {
    // Blinda contra o LLM "lembrar" o preço do histórico e ofertar sem consultar.
    for (const draft of ['A C501-133 está R$ 208.250,00.', 'Fecho em R$ 202.002,50 à vista.']) {
      expect(await g.beforeReply?.(draft, CTX_VAZIO)).toMatchObject({ tipo: 'escalate' });
    }
  });

  it('a rastreabilidade vem do NOME monetário da coluna, não só do price_source', async () => {
    // `valor_*_centavos` casa a coluna monetária, então a oferta valida mesmo
    // com priceSource: false. O flag continua sendo a declaração de intenção —
    // e a rede de segurança se alguém renomear as colunas.
    const ctx: GuardrailCtx = {
      ...CTX_VAZIO,
      toolResults: [
        {
          nome: 'condicoes_cota',
          priceSource: false,
          rows: [{ valor_tabela_centavos: TABELA, valor_minimo_centavos: PISO }],
        },
      ],
    };
    expect(await g.beforeReply?.('Fecho em R$ 202.002,50 à vista.', ctx)).toEqual(ALLOW);
  });

  it('coluna não monetária não autoriza oferta (id de cota com o mesmo número)', async () => {
    const ctx: GuardrailCtx = {
      ...CTX_VAZIO,
      toolResults: [
        { nome: 'estoque_disponivel', priceSource: false, rows: [{ cota_id: 20_200_250 }] },
      ],
    };
    expect(await g.beforeReply?.('Fecho em R$ 202.002,50 à vista.', ctx)).toMatchObject({
      tipo: 'escalate',
    });
  });
});
