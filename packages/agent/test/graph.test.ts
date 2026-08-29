import {
  createAgentRuntime,
  type ResponderEfeitos,
  TEXTO_FALLBACK,
  TEXTO_TRANSICAO,
  type TurnoInput,
  toolEscalarParaHumano,
} from '@seta/agent';
import type { AIProvider } from '@seta/ai-provider';
import { createFakeProvider } from '@seta/ai-provider/testing';
import type { ToolSpec } from '@seta/query-catalog';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const SESSION = { traceId: '01890a5d-ac96-774b-bcce-b302099a8057', clienteId: '1' };

function efeitosFake() {
  const respostas: { texto: string; meta: { escalado: boolean; fallback: boolean } }[] = [];
  let resumos = 0;
  const efeitos: ResponderEfeitos = {
    async gravarResposta(texto, meta) {
      respostas.push({ texto, meta });
    },
    async atualizarResumoSePreciso() {
      resumos += 1;
    },
  };
  return { efeitos, respostas, contarResumos: () => resumos };
}

function toolTitulos(execCount?: { n: number }): ToolSpec {
  return {
    name: 'titulos_abertos',
    entryId: 'financeiro.titulos_abertos',
    description: 'Boletos em aberto do cliente.',
    schema: z.object({}),
    priceSource: false,
    async execute() {
      if (execCount) execCount.n += 1;
      return {
        rows: [
          { id: '1', valor_centavos: '129900', vencimento: '2026-09-09', status: 'aberto' },
          { id: '2', valor_centavos: '54900', vencimento: '2026-08-20', status: 'vencido' },
        ],
        rowCount: 2,
        truncated: false,
      };
    },
  };
}

function inputBase(overrides: Partial<TurnoInput>, efeitos: ResponderEfeitos): TurnoInput {
  return {
    session: SESSION,
    persona: 'Você é o assistente da TS Explorer Demo.',
    resumo: null,
    skills: [],
    historico: [],
    textoUsuario: 'quais boletos tenho em aberto?',
    tools: [toolTitulos()],
    limites: { maxToolCalls: 6, timeoutMs: 10_000, retriesPorTool: 1 },
    efeitos,
    ...overrides,
  };
}

describe('grafo do agente', () => {
  it('fluxo feliz: tool certa → resposta com dados; trace completo; efeitos chamados', async () => {
    const fake = createFakeProvider()
      .chamaTool('titulos_abertos', {})
      .respondeTexto('Você tem 2 boletos: R$ 1.299,00 (vence 09/09/2026) e R$ 549,00 (vencido).');
    const { efeitos, respostas, contarResumos } = efeitosFake();
    const runtime = createAgentRuntime({ provider: fake });

    const r = await runtime.processarTurno(inputBase({}, efeitos));

    expect(r.resposta).toContain('R$ 1.299,00');
    expect(r.fallback).toBe(false);
    expect(respostas).toEqual([{ texto: r.resposta, meta: { escalado: false, fallback: false } }]);
    expect(contarResumos()).toBe(1);

    const tipos = r.eventos.map((e) => e.tipo);
    expect(tipos).toEqual(['contexto', 'llm', 'tool', 'llm']);
    const evTool = r.eventos.find((e) => e.tipo === 'tool');
    expect(evTool).toMatchObject({ nome: 'titulos_abertos' });
    expect(r.tokensEntrada).toBe(20); // 2 chamadas × 10 do fake
    // o system prompt renderizado contém a persona e as regras do prompt-base
    const primeiraReq = fake.requests[0];
    expect(primeiraReq?.messages[0]?.role).toBe('system');
    expect(primeiraReq?.messages[0]?.content).toContain('TS Explorer Demo');
    expect(primeiraReq?.messages[0]?.content).toContain('Dados só via tools');
  });

  it('budget estourado cai no fallback (critério 005)', async () => {
    const fake = createFakeProvider()
      .chamaTool('titulos_abertos', {})
      .chamaTool('titulos_abertos', {})
      .chamaTool('titulos_abertos', {});
    const { efeitos, respostas } = efeitosFake();
    const runtime = createAgentRuntime({ provider: fake });

    const r = await runtime.processarTurno(
      inputBase({ limites: { maxToolCalls: 2, timeoutMs: 10_000, retriesPorTool: 1 } }, efeitos),
    );

    expect(r.fallback).toBe(true);
    expect(r.fallbackMotivo).toMatch(/budget de tool calls/);
    expect(r.resposta).toBe(TEXTO_FALLBACK);
    expect(respostas[0]?.meta.fallback).toBe(true);
    expect(r.eventos.some((e) => e.tipo === 'fallback')).toBe(true);
  });

  it('tool falha 2x (1 retry) → erro vai ao modelo, que admite não saber', async () => {
    const execucoes = { n: 0 };
    const toolQueFalha: ToolSpec = {
      ...toolTitulos(),
      async execute() {
        execucoes.n += 1;
        throw new Error('conexão com ERP caiu');
      },
    };
    const fake = createFakeProvider()
      .chamaTool('titulos_abertos', {})
      .respondeTexto('Não consegui consultar seus boletos agora. Quer falar com um atendente?');
    const { efeitos } = efeitosFake();
    const runtime = createAgentRuntime({ provider: fake });

    const r = await runtime.processarTurno(inputBase({ tools: [toolQueFalha] }, efeitos));

    expect(execucoes.n).toBe(2); // 1 tentativa + 1 retry
    const evTool = r.eventos.find((e) => e.tipo === 'tool');
    expect(evTool).toMatchObject({ erro: 'conexão com ERP caiu' });
    expect(r.resposta).toMatch(/atendente/);
    expect(r.fallback).toBe(false); // o modelo respondeu honesto; não foi fallback forçado
  });

  it('escalar_para_humano marca o turno como escalado', async () => {
    const fake = createFakeProvider()
      .chamaTool('escalar_para_humano', { motivo: 'pedido de desconto' })
      .respondeTexto('Entendi! Vou te passar para um de nossos atendentes.');
    const { efeitos, respostas } = efeitosFake();
    const runtime = createAgentRuntime({ provider: fake });

    const r = await runtime.processarTurno(
      inputBase({ tools: [toolTitulos(), toolEscalarParaHumano()] }, efeitos),
    );

    expect(r.escalado).toBe(true);
    expect(r.eventos.some((e) => e.tipo === 'escalado')).toBe(true);
    expect(respostas[0]?.meta.escalado).toBe(true);
  });

  it('timeout de turno cai no fallback', async () => {
    // 1ª chamada (lenta) estoura o deadline pedindo tool; o nó tools detecta e faz fallback
    const lentoComTool: AIProvider = {
      modelId: 'lento',
      async chat() {
        await new Promise((r) => setTimeout(r, 80));
        return {
          content: null,
          toolCalls: [{ id: 'call_1', name: 'titulos_abertos', argumentsJson: '{}' }],
          tokensEntrada: 1,
          tokensSaida: 1,
          finishReason: 'tool_calls',
        };
      },
      async embed() {
        return [];
      },
    };
    const { efeitos } = efeitosFake();
    const runtime = createAgentRuntime({ provider: lentoComTool });
    const r = await runtime.processarTurno(
      inputBase({ limites: { maxToolCalls: 6, timeoutMs: 50, retriesPorTool: 1 } }, efeitos),
    );
    expect(r.fallback).toBe(true);
    expect(r.fallbackMotivo).toBe('timeout de turno');
    expect(r.resposta).toBe(TEXTO_FALLBACK);
  });

  it('guardrail escalate leva à mensagem de transição com verdict no trace', async () => {
    const fake = createFakeProvider().respondeTexto('Te dou 20% de desconto!');
    const { efeitos } = efeitosFake();
    const runtime = createAgentRuntime({
      provider: fake,
      guardrails: [
        {
          nome: 'sem-desconto',
          async beforeReply(draft) {
            return draft.includes('desconto')
              ? { tipo: 'escalate', trigger: 'negociacao_preco' }
              : { tipo: 'allow' };
          },
        },
      ],
    });

    const r = await runtime.processarTurno(inputBase({}, efeitos));

    expect(r.fallback).toBe(true);
    expect(r.escalado).toBe(true);
    expect(r.escaladoTrigger).toBe('negociacao_preco');
    expect(r.resposta).toBe(TEXTO_TRANSICAO);
    const verdict = r.eventos.find((e) => e.tipo === 'verdict');
    expect(verdict).toMatchObject({
      guardrail: 'sem-desconto',
      verdict: { tipo: 'escalate', trigger: 'negociacao_preco' },
    });
  });

  it('guardrail rewrite ajusta o draft e a resposta segue', async () => {
    const fake = createFakeProvider().respondeTexto('Segue seu pedido.');
    const { efeitos } = efeitosFake();
    const runtime = createAgentRuntime({
      provider: fake,
      guardrails: [
        {
          nome: 'assinatura',
          async beforeReply(draft) {
            return { tipo: 'rewrite', patch: `${draft} — Equipe TS Explorer` };
          },
        },
      ],
    });
    const r = await runtime.processarTurno(inputBase({}, efeitos));
    expect(r.resposta).toBe('Segue seu pedido. — Equipe TS Explorer');
    expect(r.fallback).toBe(false);
  });

  it('2 falhas de tool no turno escalam (006)', async () => {
    const toolQueFalha: ToolSpec = {
      ...toolTitulos(),
      async execute() {
        throw new Error('ERP fora do ar');
      },
    };
    const fake = createFakeProvider()
      .chamaTool('titulos_abertos', {})
      .chamaTool('titulos_abertos', {});
    const { efeitos } = efeitosFake();
    const runtime = createAgentRuntime({ provider: fake });
    const r = await runtime.processarTurno(inputBase({ tools: [toolQueFalha] }, efeitos));
    expect(r.fallback).toBe(true);
    expect(r.escalado).toBe(true);
    expect(r.escaladoTrigger).toBe('falhas_tool');
    expect(r.resposta).toBe(TEXTO_TRANSICAO);
  });

  it('#27: LLM pendurado é CANCELADO no deadline do turno (fallback, sem travar)', async () => {
    // provider que nunca responde, mas respeita o AbortSignal do turno
    const pendurado = {
      modelId: 'pendurado',
      chat: (req: { signal?: AbortSignal }) =>
        new Promise<never>((_, reject) => {
          req.signal?.addEventListener('abort', () => reject(new Error('abortado')));
        }),
      embed: async () => [],
    };
    const { efeitos } = efeitosFake();
    const runtime = createAgentRuntime({ provider: pendurado as never });
    const t0 = Date.now();
    const r = await runtime.processarTurno(
      inputBase({ limites: { maxToolCalls: 6, timeoutMs: 300, retriesPorTool: 1 } }, efeitos),
    );
    expect(Date.now() - t0).toBeLessThan(3_000); // sem o abort, penduraria para sempre
    expect(r.fallback).toBe(true);
    expect(r.fallbackMotivo).toBe('timeout de turno');
    expect(r.resposta).toBe(TEXTO_FALLBACK);
  });
});
