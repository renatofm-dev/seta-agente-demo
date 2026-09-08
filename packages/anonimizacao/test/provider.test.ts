import { createFakeProvider } from '@seta/ai-provider/testing';
import {
  createAnonimizador,
  createAnonymizingProvider,
  createDicionarioDetector,
  createRegexDetector,
  type EventoAnonimizacao,
} from '@seta/anonimizacao';
import { describe, expect, it } from 'vitest';

/**
 * Critérios da 016 com o FakeAIProvider atrás do decorator: o que o fake
 * recebe é exatamente o que chegaria ao provedor remoto.
 */

const CPF = '529.982.247-25';
const NOME = 'Renato Martins';
const TEL = '(61) 98224-8071';
const EMAIL = 'renato@x.com';

function montar() {
  const fake = createFakeProvider();
  const eventos: EventoAnonimizacao[] = [];
  const provider = createAnonymizingProvider(fake, {
    anonimizador: createAnonimizador({
      detectores: [createRegexDetector(), createDicionarioDetector({ nomes: () => [NOME] })],
    }),
    sink: (ev) => eventos.push(ev),
  });
  return { fake, provider, eventos };
}

function tudoQueOFakeViu(fake: ReturnType<typeof createFakeProvider>): string {
  return JSON.stringify(fake.requests);
}

describe('decorator de anonimização do AIProvider', () => {
  it('o provedor só vê tokens; a resposta volta com os valores reais', async () => {
    const { fake, provider, eventos } = montar();
    fake.respondeTexto('Certo, [NOME_1], anotei o [CPF_1] e ligo no [TEL_1].');
    const res = await provider.chat({
      traceId: 'trace-1',
      messages: [
        { role: 'system', content: 'Você atende cotistas.' },
        { role: 'user', content: `meu cpf é ${CPF}, sou o ${NOME}, fone ${TEL}, ${EMAIL}` },
      ],
    });
    expect(fake.requests[0]?.messages[1]?.content).toBe(
      'meu cpf é [CPF_1], sou o [NOME_1], fone [TEL_1], [EMAIL_1]',
    );
    for (const pii of [CPF, '52998224725', NOME, 'Renato', TEL, EMAIL]) {
      expect(tudoQueOFakeViu(fake)).not.toContain(pii);
    }
    expect(res.content).toBe(`Certo, ${NOME}, anotei o ${CPF} e ligo no ${TEL}.`);
    expect(eventos).toHaveLength(1);
    expect(eventos[0]).toMatchObject({
      traceId: 'trace-1',
      operacao: 'chat',
      modelo: 'fake-model',
      substituicoes: { cpf: 1, nome: 1, telefone: 1, email: 1 },
      total: 4,
      tokensDesconhecidos: 0,
    });
  });

  it('tool call da resposta e do histórico: argumentos vão tokenizados e voltam reais', async () => {
    const { fake, provider } = montar();
    fake.chamaTool('escalar_para_humano', { motivo: 'cliente [NOME_1] pediu desconto' });
    const res = await provider.chat({
      messages: [
        { role: 'user', content: `sou o ${NOME}` },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            {
              id: 'c1',
              name: 'buscar_conhecimento',
              argumentsJson: `{"pergunta":"quem é ${NOME}"}`,
            },
          ],
        },
        { role: 'tool', content: '{"rows":[]}', toolCallId: 'c1' },
      ],
    });
    expect(fake.requests[0]?.messages[1]?.toolCalls?.[0]?.argumentsJson).toBe(
      '{"pergunta":"quem é [NOME_1]"}',
    );
    expect(res.toolCalls[0]?.argumentsJson).toBe(
      JSON.stringify({ motivo: `cliente ${NOME} pediu desconto` }),
    );
  });

  it('numeração estável na chamada: mesmo CPF em duas mensagens ⇒ [CPF_1]; nome novo ⇒ [NOME_2]', async () => {
    const { fake, provider } = montar();
    fake.respondeTexto('ok');
    await provider.chat({
      messages: [
        { role: 'user', content: `cpf ${CPF}` },
        { role: 'assistant', content: 'anotado' },
        {
          role: 'user',
          content: `confirmando 52998224725, meu nome é Ana Paula e o ${NOME} é meu marido`,
        },
      ],
    });
    const m = fake.requests[0]?.messages;
    expect(m?.[0]?.content).toBe('cpf [CPF_1]');
    expect(m?.[2]?.content).toBe(
      'confirmando [CPF_1], meu nome é [NOME_2] e o [NOME_1] é meu marido',
    );
  });

  it('token inventado pela LLM fica como está e é contado', async () => {
    const { fake, provider, eventos } = montar();
    fake.respondeTexto('Olá [NOME_1] e [NOME_9].');
    const res = await provider.chat({ messages: [{ role: 'user', content: `sou o ${NOME}` }] });
    expect(res.content).toBe(`Olá ${NOME} e [NOME_9].`);
    expect(eventos[0]?.tokensDesconhecidos).toBe(1);
  });

  it('anonimizacao.destokenizar=false devolve a resposta tokenizada (distiller)', async () => {
    const { fake, provider } = montar();
    fake.respondeTexto('Quando [NOME_1] pede boleto, ofereça PIX.');
    const res = await provider.chat({
      anonimizacao: { destokenizar: false },
      messages: [{ role: 'user', content: `sinal: ${NOME} pediu boleto` }],
    });
    expect(res.content).toBe('Quando [NOME_1] pede boleto, ofereça PIX.');
  });

  it('embed anonimiza sem destokenizar', async () => {
    const { fake, provider, eventos } = montar();
    const embedOriginal = fake.embed.bind(fake);
    let visto: readonly string[] = [];
    fake.embed = async (texts) => {
      visto = texts;
      return embedOriginal(texts);
    };
    await provider.embed([`meu cpf ${CPF}`]);
    expect(visto).toEqual(['meu cpf [CPF_1]']);
    expect(eventos[0]).toMatchObject({ operacao: 'embed', substituicoes: { cpf: 1 } });
  });

  it('modelId e demais campos da request passam intactos', async () => {
    const { fake, provider } = montar();
    fake.respondeTexto('ok');
    const signal = new AbortController().signal;
    await provider.chat({ messages: [{ role: 'user', content: 'oi' }], temperature: 0, signal });
    expect(provider.modelId).toBe('fake-model');
    expect(fake.requests[0]).toMatchObject({ temperature: 0, signal });
  });
});
