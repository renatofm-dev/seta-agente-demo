import {
  Cofre,
  createAnonimizador,
  createDicionarioDetector,
  createRegexDetector,
  type Deteccao,
  resolverSobreposicao,
} from '@seta/anonimizacao';
import { describe, expect, it } from 'vitest';

const d = (tipo: Deteccao['tipo'], inicio: number, fim: number, valor: string): Deteccao => ({
  tipo,
  inicio,
  fim,
  valor,
  detector: 'teste',
});

describe('cofre', () => {
  it('mesmo valor normalizado ⇒ mesmo token; numeração por tipo e por aparição', () => {
    const c = new Cofre();
    expect(c.token(d('cpf', 0, 14, '529.982.247-25'))).toBe('[CPF_1]');
    expect(c.token(d('cpf', 0, 11, '52998224725'))).toBe('[CPF_1]');
    expect(c.token(d('nome', 0, 6, 'Renato'))).toBe('[NOME_1]');
    expect(c.token(d('nome', 0, 6, 'renato'))).toBe('[NOME_1]');
    expect(c.token(d('nome', 0, 5, 'Renan'))).toBe('[NOME_2]');
    expect(c.token(d('cpf', 0, 14, '123.456.789-09'))).toBe('[CPF_2]');
    expect(c.contagem()).toEqual({ cpf: 2, nome: 2 });
  });

  it('destokenizar tolera caixa e espaço; token desconhecido fica e é contado', () => {
    const c = new Cofre();
    c.token(d('nome', 0, 6, 'Renato'));
    c.token(d('cpf', 0, 14, '529.982.247-25'));
    const r = c.destokenizar('Certo, [nome_1], anotei o [ CPF_1 ] e o [NOME_9].');
    expect(r.texto).toBe('Certo, Renato, anotei o 529.982.247-25 e o [NOME_9].');
    expect(r.desconhecidos).toBe(1);
  });
});

describe('resolverSobreposicao', () => {
  it('span mais longo vence; sem sobreposição, ordem por início', () => {
    const r = resolverSobreposicao([
      d('nome', 4, 10, 'Renato'),
      d('nome', 4, 18, 'Renato Martins'),
      d('nome', 11, 18, 'Martins'),
      d('cpf', 30, 44, '529.982.247-25'),
    ]);
    expect(r.map((x) => x.valor)).toEqual(['Renato Martins', '529.982.247-25']);
  });
});

describe('anonimizador', () => {
  const anon = createAnonimizador({
    detectores: [
      createRegexDetector(),
      createDicionarioDetector({ nomes: () => ['Renato Martins'] }),
    ],
  });

  it('substitui do fim para o início sem deslocar offsets; conta por tipo', async () => {
    const r = await anon.anonimizar([
      'meu cpf é 529.982.247-25, sou o Renato Martins, fone (61) 98224-8071, renato@x.com',
    ]);
    expect(r.textos[0]).toBe('meu cpf é [CPF_1], sou o [NOME_1], fone [TEL_1], [EMAIL_1]');
    expect(r.substituicoes).toEqual({ cpf: 1, nome: 1, telefone: 1, email: 1 });
    expect(r.total).toBe(4);
  });

  it('cofre compartilhado entre textos: mesmo CPF com e sem pontuação ⇒ um token', async () => {
    const r = await anon.anonimizar([
      'cpf 529.982.247-25',
      'confirmando 52998224725',
      'e o Renato',
    ]);
    expect(r.textos).toEqual(['cpf [CPF_1]', 'confirmando [CPF_1]', 'e o [NOME_1]']);
    expect(r.substituicoes).toEqual({ cpf: 1, nome: 1 });
  });

  it('FALSO POSITIVO: dado que o guardrail de preço precisa ver fica intacto', async () => {
    const texto =
      'Seu contrato 10001 tem 4 parcelas vencidas somando R$ 4.623,00. ' +
      'A C501-133 está R$ 208.250,00 (20825000); piso 20200250; vencimento 2026-09-06.';
    const r = await anon.anonimizar([texto]);
    expect(r.textos[0]).toBe(texto);
    expect(r.total).toBe(0);
  });

  it('texto vazio passa direto', async () => {
    const r = await anon.anonimizar(['', 'sem nada']);
    expect(r.textos).toEqual(['', 'sem nada']);
  });
});
