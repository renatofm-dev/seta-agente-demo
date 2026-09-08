import {
  createDicionarioDetector,
  createRegexDetector,
  type Deteccao,
  partesDeNome,
} from '@seta/anonimizacao';
import { describe, expect, it } from 'vitest';

const regex = createRegexDetector();

async function tipos(
  det: { detectar: (t: string) => Promise<readonly Deteccao[]> | readonly Deteccao[] },
  texto: string,
) {
  return (await det.detectar(texto)).map((d) => [d.tipo, d.valor] as const);
}

describe('detector regex', () => {
  it('e-mail', async () => {
    expect(await tipos(regex, 'fale com renato@setaia.com.br hoje')).toEqual([
      ['email', 'renato@setaia.com.br'],
    ]);
  });

  it('CPF só com DV válido — com pontuação, com espaço, colado', async () => {
    expect(await tipos(regex, 'cpf 529.982.247-25')).toEqual([['cpf', '529.982.247-25']]);
    expect(await tipos(regex, 'cpf 529 982 247 25')).toEqual([['cpf', '529 982 247 25']]);
    expect(await tipos(regex, 'cpf 52998224725')).toEqual([['cpf', '52998224725']]);
    expect(await tipos(regex, 'cpf 111.111.111-11')).toEqual([]);
    expect(await tipos(regex, 'cpf 123.456.789-00')).toEqual([]);
  });

  it('CNPJ', async () => {
    expect(await tipos(regex, 'cnpj 11.222.333/0001-81')).toEqual([['cnpj', '11.222.333/0001-81']]);
  });

  it('telefone: com DDD em várias grafias; sem DDD só com hífen', async () => {
    for (const t of ['(61) 98224-8071', '+55 61 98224-8071', '61982248071', '61 98224 8071']) {
      expect(await tipos(regex, `fone ${t} ok`), t).toEqual([['telefone', t]]);
    }
    expect(await tipos(regex, 'liga no 98224-8071')).toEqual([['telefone', '98224-8071']]);
    expect(await tipos(regex, 'liga no 3244-1234')).toEqual([['telefone', '3244-1234']]);
    // DDD inválido não casa o padrão com DDD — mas o trecho com hífen ainda é
    // tokenizado (na dúvida, privacidade); só o (10) fica de fora
    expect(await tipos(regex, '(10) 98224-8071')).toEqual([['telefone', '98224-8071']]);
    // CPF colado com 11 dígitos NÃO é telefone (DV de CPF vence)
    expect(await tipos(regex, 'doc 52998224725')).toEqual([['cpf', '52998224725']]);
  });

  it('CEP: com hífen, ou colado depois da palavra cep', async () => {
    expect(await tipos(regex, 'moro no 70000-000')).toEqual([['cep', '70000-000']]);
    expect(await tipos(regex, 'CEP: 70000000')).toEqual([['cep', 'CEP: 70000000']]);
    expect(await tipos(regex, 'valor 70000000')).toEqual([]);
  });

  it('cartão (Luhn) e placa (maiúscula)', async () => {
    expect(await tipos(regex, 'cartão 4111 1111 1111 1111')).toEqual([
      ['cartao', '4111 1111 1111 1111'],
    ]);
    expect(await tipos(regex, 'cartão 4111 1111 1111 1112')).toEqual([]);
    expect(await tipos(regex, 'placa ABC1D23 e ABC-1234')).toEqual([
      ['placa', 'ABC1D23'],
      ['placa', 'ABC-1234'],
    ]);
    expect(await tipos(regex, 'placa abc1d23')).toEqual([]);
  });

  it('FALSO POSITIVO: contrato, valor em R$, centavos e data ficam intactos', async () => {
    const texto =
      'contrato 10001, cota C501-133, R$ 208.250,00 (20825000 centavos), piso 20200250, ' +
      'vencimento 2026-09-06, parcela 12/583, 66000 pontos, Torre 2 apto 503';
    expect(await tipos(regex, texto)).toEqual([]);
  });
});

describe('detector dicionário + gatilhos', () => {
  it('partesDeNome: ≥3 letras, sem dígito, sem stoplist; parênteses caem', () => {
    expect(partesDeNome('Renato Martins')).toEqual(['Renato Martins', 'Renato', 'Martins']);
    expect(partesDeNome('Renan (com 9)')).toEqual(['Renan']);
    expect(partesDeNome('Contrato 10001')).toEqual([]);
    expect(partesDeNome('Titular do contrato')).toEqual([]);
    expect(partesDeNome('Ana')).toEqual(['Ana']);
  });

  it('acha o nome do contato em qualquer caixa, por fronteira de letra', async () => {
    const det = createDicionarioDetector({
      nomes: () => ['Renato Martins', 'Renan (com 9)', 'Contrato 10001'],
    });
    expect(await tipos(det, 'Oi RENATO, aqui é o Renan. O Renatão não.')).toEqual([
      ['nome', 'RENATO'],
      ['nome', 'Renan'],
    ]);
    expect(await tipos(det, 'o contrato 10001 está ativo')).toEqual([]);
  });

  it('nome completo vem como span próprio (mais longo vence depois)', async () => {
    const det = createDicionarioDetector({ nomes: () => ['Renato Martins'] });
    const achados = await det.detectar('sou Renato Martins');
    expect(achados.map((d) => d.valor).sort()).toEqual(['Martins', 'Renato', 'Renato Martins']);
  });

  it('gatilho forte aceita minúscula; gatilho fraco exige maiúscula', async () => {
    const det = createDicionarioDetector({ nomes: () => [] });
    expect(await tipos(det, 'meu nome é Carlos Eduardo Pereira, tudo bem?')).toEqual([
      ['nome', 'Carlos Eduardo Pereira'],
    ]);
    expect(await tipos(det, 'me chamo joão da silva')).toEqual([['nome', 'joão da silva']]);
    expect(await tipos(det, 'aqui é a Ana Paula')).toEqual([['nome', 'Ana Paula']]);
    expect(await tipos(det, 'sou a favor do distrato')).toEqual([]);
  });

  it('nomes assíncronos (banco com TTL)', async () => {
    const det = createDicionarioDetector({ nomes: async () => ['Beatriz'] });
    expect(await tipos(det, 'oi beatriz')).toEqual([['nome', 'beatriz']]);
  });
});
