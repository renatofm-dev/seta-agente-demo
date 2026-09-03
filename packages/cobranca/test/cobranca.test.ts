import { createFakeProvider } from '@seta/ai-provider/testing';
import {
  type Candidato,
  type ContextoFluxo,
  formatarData,
  formatarReais,
  iniciar,
  interpretarResposta,
  mensagensEmitida,
  normalizar,
  opcoesDe,
  parsearResposta,
  referenciaCobranca,
  TEXTO_CANCELADO,
  TEXTO_EM_DIA,
  TEXTO_METODO,
  TEXTO_NAO_ENTENDI,
  textoLista,
  transicionar,
} from '@seta/cobranca';
import { describe, expect, it } from 'vitest';

const cand = (p: Partial<Candidato> & { tituloId: string }): Candidato => ({
  origem: 'saldo',
  parcela: 12,
  totalParcelas: 120,
  valorCentavos: 85000,
  vencimento: '2026-07-10',
  situacao: 'vencida',
  ...p,
});

const VENCIDAS = [
  cand({ tituloId: '11', parcela: 12, vencimento: '2026-06-10', valorCentavos: 85000 }),
  cand({ tituloId: '12', parcela: 13, vencimento: '2026-07-10', valorCentavos: 85000 }),
  cand({ tituloId: '13', parcela: 14, vencimento: '2026-08-10', valorCentavos: 85000 }),
];
const PROXIMA = cand({
  tituloId: '14',
  parcela: 15,
  vencimento: '2026-10-10',
  situacao: 'a_vencer',
});

const CTX: ContextoFluxo = {
  tetoCentavos: 500_000,
  maxPorDia: 3,
  cobrancasHoje: 0,
  contratoStatus: 'ativo',
  distratoEmAnalise: false,
  temDocumento: true,
};

describe('spec 014 — render', () => {
  it('formata reais e datas no padrão do WhatsApp', () => {
    expect(formatarReais(85050)).toBe('R$ 850,50');
    expect(formatarReais(123456789)).toBe('R$ 1.234.567,89');
    expect(formatarReais(5)).toBe('R$ 0,05');
    expect(formatarData('2026-07-10')).toBe('10/07/2026');
    expect(formatarData('2026-07-10T12:00:00Z')).toBe('10/07/2026');
  });

  it('lista vencidas da mais antiga para a mais nova, a próxima e "todas" só com ≥2 vencidas', () => {
    const texto = textoLista({ candidatos: [...VENCIDAS, PROXIMA] });
    expect(texto).toContain('1) Parcela 12/120 (saldo) — R$ 850,00 — venceu em 10/06/2026');
    expect(texto).toContain('4) Parcela 15/120 (saldo) — R$ 850,00 — vence em 10/10/2026');
    expect(texto).toContain('5) Todas as vencidas (3) — R$ 2.550,00');
    expect(opcoesDe({ candidatos: [VENCIDAS[0] as Candidato, PROXIMA] })).toHaveLength(2); // sem "todas"
  });

  it('mensagens de emissão: código sozinho na 2ª mensagem; cartão só link', () => {
    const base = {
      valorCentavos: 85000,
      vencimento: '2026-09-05',
      urlFatura: 'https://x/i/1',
      urlBoleto: 'https://x/b/1',
      linhaDigitavel: '2379000',
      pixCopiaCola: '000201',
      reenvio: false,
    };
    expect(mensagensEmitida({ ...base, metodo: 'pix' })).toEqual([
      expect.stringContaining('Seu PIX está pronto'),
      '000201',
    ]);
    const boleto = mensagensEmitida({ ...base, metodo: 'boleto' });
    expect(boleto[0]).toContain('https://x/b/1');
    expect(boleto[1]).toBe('2379000');
    const cartao = mensagensEmitida({ ...base, metodo: 'cartao', reenvio: true });
    expect(cartao).toHaveLength(1);
    expect(cartao[0]).toContain('reenviando');
    expect(cartao[0]).toContain('https://x/i/1');
    expect(cartao[0]).toContain('nunca peço dados do cartão');
  });
});

describe('spec 014 — referência externa', () => {
  it('é determinística e independe da ordem dos títulos', () => {
    expect(referenciaCobranca('10002', ['13', '11', '12'])).toBe('contrato:10002:titulos:11+12+13');
    expect(referenciaCobranca('10002', ['12', '12'])).toBe('contrato:10002:titulos:12');
    expect(() => referenciaCobranca('10002', [])).toThrow();
  });
});

describe('spec 014 — parser determinístico', () => {
  const selecao = iniciar([...VENCIDAS, PROXIMA], CTX).estado;
  const metodo = transicionar(selecao, { tipo: 'escolher', indice: 1 }, CTX).estado;
  const confirmacao = transicionar(metodo, { tipo: 'metodo', metodo: 'pix' }, CTX).estado;

  it('normaliza acentos, caixa e pontuação', () => {
    expect(normalizar('  NÃO, obrigado!! ')).toBe('nao obrigado');
  });

  it('seleção: número, ordinal, todas; fora do range ⇒ null (LLM decide)', () => {
    expect(parsearResposta('1', selecao)).toEqual({ tipo: 'escolher', indice: 1 });
    expect(parsearResposta('a segunda', selecao)).toEqual({ tipo: 'escolher', indice: 2 });
    expect(parsearResposta('5', selecao)).toEqual({ tipo: 'todas' }); // 5 = "Todas as vencidas"
    expect(parsearResposta('todas', selecao)).toEqual({ tipo: 'todas' });
    expect(parsearResposta('9', selecao)).toBeNull();
    expect(parsearResposta('a de julho', selecao)).toBeNull();
  });

  it('método: número ou nome; cancelamento em qualquer etapa', () => {
    expect(parsearResposta('2', metodo)).toEqual({ tipo: 'metodo', metodo: 'pix' });
    expect(parsearResposta('Boleto', metodo)).toEqual({ tipo: 'metodo', metodo: 'boleto' });
    expect(parsearResposta('cartão de crédito', metodo)).toEqual({
      tipo: 'metodo',
      metodo: 'cartao',
    });
    expect(parsearResposta('cancelar', metodo)).toEqual({ tipo: 'cancelar' });
    expect(parsearResposta('deixa pra lá', selecao)).toEqual({ tipo: 'cancelar' });
  });

  it('confirmação: sim/não, 👍, e troca de método sem confirmar', () => {
    expect(parsearResposta('sim', confirmacao)).toEqual({ tipo: 'confirmar' });
    expect(parsearResposta('pode gerar', confirmacao)).toEqual({ tipo: 'confirmar' });
    expect(parsearResposta('👍', confirmacao)).toEqual({ tipo: 'confirmar' });
    expect(parsearResposta('não', confirmacao)).toEqual({ tipo: 'cancelar' });
    expect(parsearResposta('melhor no boleto', confirmacao)).toEqual({
      tipo: 'metodo',
      metodo: 'boleto',
    });
    expect(parsearResposta('sim', selecao)).toBeNull(); // "sim" não escolhe parcela
    expect(parsearResposta('hmm talvez', confirmacao)).toBeNull();
  });
});

describe('spec 014 — máquina de estados', () => {
  it('bloqueia contrato cancelado, distrato em análise, sem CPF e limite diário — sempre escalando', () => {
    const cancelado = iniciar(VENCIDAS, { ...CTX, contratoStatus: 'cancelado' });
    expect(cancelado.estado.encerramento).toBe('bloqueado');
    expect(cancelado.efeito).toBe('escalar_bloqueio');
    expect(cancelado.mensagens[0]).toContain('cancelado');

    expect(iniciar(VENCIDAS, { ...CTX, distratoEmAnalise: true }).mensagens[0]).toContain(
      'distrato',
    );
    expect(iniciar(VENCIDAS, { ...CTX, temDocumento: false }).estado.encerramento).toBe(
      'sem_documento',
    );
    const limite = iniciar(VENCIDAS, { ...CTX, cobrancasHoje: 3 });
    expect(limite.estado.encerramento).toBe('limite_dia');
    expect(limite.efeito).toBe('escalar_bloqueio');
  });

  it('sem candidato ⇒ em dia; 1 candidato ⇒ pula direto para o método', () => {
    const vazio = iniciar([], CTX);
    expect(vazio.estado.encerramento).toBe('sem_pendencia');
    expect(vazio.mensagens).toEqual([TEXTO_EM_DIA]);

    const um = iniciar([PROXIMA], CTX);
    expect(um.estado.etapa).toBe('metodo');
    expect(um.estado.selecao).toEqual(['14']);
    expect(um.mensagens[0]).toContain('Seu contrato está em dia');
    expect(um.mensagens[0]).toContain(TEXTO_METODO);
  });

  it('caminho feliz: lista → escolhe → método → confirmação → emitir', () => {
    const t0 = iniciar([PROXIMA, ...VENCIDAS], CTX); // ordena: vencidas antes da próxima
    expect(t0.estado.etapa).toBe('selecao');
    expect(t0.estado.candidatos[0]?.tituloId).toBe('11');

    const t1 = transicionar(t0.estado, { tipo: 'escolher', indice: 1 }, CTX);
    expect(t1.estado.etapa).toBe('metodo');
    expect(t1.estado.selecao).toEqual(['11']);
    expect(t1.mensagens).toEqual([TEXTO_METODO]);

    const t2 = transicionar(t1.estado, { tipo: 'metodo', metodo: 'pix' }, CTX);
    expect(t2.estado.etapa).toBe('confirmacao');
    expect(t2.mensagens[0]).toContain('Total: R$ 850,00');
    expect(t2.mensagens[0]).toContain('Forma: PIX');

    const t3 = transicionar(t2.estado, { tipo: 'confirmar' }, CTX);
    expect(t3.estado.etapa).toBe('encerrado');
    expect(t3.estado.encerramento).toBe('emitindo');
    expect(t3.efeito).toBe('emitir');
    expect(t3.mensagens[0]).toContain('gerando seu PIX');
  });

  it('"todas" seleciona só as vencidas; total acima do teto pede aprovação', () => {
    const t0 = iniciar([...VENCIDAS, PROXIMA], CTX);
    const t1 = transicionar(t0.estado, { tipo: 'todas' }, CTX);
    expect(t1.estado.selecao).toEqual(['11', '12', '13']);
    const t2 = transicionar(t1.estado, { tipo: 'metodo', metodo: 'boleto' }, CTX);
    const t3 = transicionar(t2.estado, { tipo: 'confirmar' }, { ...CTX, tetoCentavos: 100_000 });
    expect(t3.efeito).toBe('emitir_com_aprovacao');
    expect(t3.mensagens[0]).toContain('R$ 2.550,00');
    expect(t3.mensagens[0]).toContain('aprovação de um atendente');
  });

  it('não entendi: re-pergunta uma vez, na segunda abandona em silêncio; cancelar encerra com texto', () => {
    const t0 = iniciar(VENCIDAS, CTX);
    const t1 = transicionar(t0.estado, { tipo: 'nao_entendi' }, CTX);
    expect(t1.estado.etapa).toBe('selecao');
    expect(t1.mensagens).toEqual([TEXTO_NAO_ENTENDI]);
    const t2 = transicionar(t1.estado, { tipo: 'nao_entendi' }, CTX);
    expect(t2.estado.encerramento).toBe('abandonado');
    expect(t2.mensagens).toEqual([]);

    const c = transicionar(t0.estado, { tipo: 'cancelar' }, CTX);
    expect(c.estado.encerramento).toBe('cancelado');
    expect(c.mensagens).toEqual([TEXTO_CANCELADO]);

    // ação válida zera o contador
    const ok = transicionar(t1.estado, { tipo: 'escolher', indice: 2 }, CTX);
    expect(ok.estado.naoEntendi).toBe(0);
  });

  it('ação fora da etapa conta como não entendida; escolha inválida idem', () => {
    const t0 = iniciar(VENCIDAS, CTX);
    expect(transicionar(t0.estado, { tipo: 'confirmar' }, CTX).mensagens).toEqual([
      TEXTO_NAO_ENTENDI,
    ]);
    expect(transicionar(t0.estado, { tipo: 'escolher', indice: 99 }, CTX).mensagens).toEqual([
      TEXTO_NAO_ENTENDI,
    ]);
  });
});

describe('spec 014 — interpretarResposta (LLM como fallback)', () => {
  const selecao = iniciar([...VENCIDAS, PROXIMA], CTX).estado;

  it('aceita JSON válido para a etapa e rejeita índice fora da lista', async () => {
    const fake = createFakeProvider().respondeTexto('{"acao":"escolher","indice":2}');
    const r = await interpretarResposta(fake, selecao, 'a de julho');
    expect(r.acao).toEqual({ tipo: 'escolher', indice: 2 });
    expect(r.tokensEntrada).toBeGreaterThan(0);
    expect(fake.requests[0]?.messages[0]?.content).toContain('Parcela 13/120');

    const fora = createFakeProvider().respondeTexto(
      '```json\n{"acao":"escolher","indice":42}\n```',
    );
    expect((await interpretarResposta(fora, selecao, 'x')).acao).toEqual({ tipo: 'nao_entendi' });
  });

  it('confirmar fora da confirmação, JSON inválido ou provider falhando ⇒ nao_entendi', async () => {
    const confirmaCedo = createFakeProvider().respondeTexto('{"acao":"confirmar"}');
    expect((await interpretarResposta(confirmaCedo, selecao, 'sim')).acao).toEqual({
      tipo: 'nao_entendi',
    });
    const lixo = createFakeProvider().respondeTexto('claro, a segunda!');
    expect((await interpretarResposta(lixo, selecao, 'x')).acao).toEqual({ tipo: 'nao_entendi' });
    const quebrado = createFakeProvider(); // fila vazia ⇒ chat() lança
    const r = await interpretarResposta(quebrado, selecao, 'x');
    expect(r.acao).toEqual({ tipo: 'nao_entendi' });
    expect(r.tokensEntrada).toBe(0);
  });
});
