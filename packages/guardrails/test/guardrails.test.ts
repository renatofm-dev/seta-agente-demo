import { createFakeProvider } from '@seta/ai-provider/testing';
import {
  ALLOW,
  classificarIntencao,
  extrairValoresMonetarios,
  type GuardrailCtx,
  guardrailPreco,
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
});
