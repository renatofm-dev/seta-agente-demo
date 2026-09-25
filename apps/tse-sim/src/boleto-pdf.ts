import {
  caixa,
  campo,
  cinza,
  dataBr,
  LARGURA,
  linha,
  montarPdf,
  preto,
  reais,
  tarjaSimulado,
  texto,
} from './pdf.js';

/**
 * Boleto SINTÉTICO em PDF — 040.
 *
 * `PainelDoCliente/SegundaViaBoleto/{id}` devolve um PDF, e o exemplo do
 * fornecedor **não está no repo**: são 118 KB de um boleto real, com cedente,
 * CPF e código de barras de gente de verdade, e nenhuma regra de sanitização
 * alcança bytes de PDF (decisão da 035; a fixture guarda só `contentType`,
 * `bodyBytes` e o `sha256` como prova de procedência).
 *
 * O que a 040 precisa do fornecedor é a FORMA — que é PDF, que vem com
 * `application/pdf` —, não o documento. Então o simulador gera o seu, a partir
 * do `erp_mock`, e deixa claro no papel que é simulado: um PDF que PARECE um
 * boleto pagável e não é seria pior que texto nenhum.
 *
 * A máquina de PDF (objetos, `xref`, primitivas de desenho) saiu daqui para
 * `pdf.ts` na 046, quando o contrato virou o segundo documento a desenhar.
 */

export interface DadosBoleto {
  readonly cedente: string;
  readonly sacado: string;
  readonly sacadoCpf: string;
  readonly nossoNumero: string;
  readonly contrato: string;
  /** "3/24" — o que o cotista reconhece na conversa. */
  readonly parcela: string;
  /** `YYYY-MM-DD`. */
  readonly vencimento: string;
  readonly valorReais: number;
  readonly linhaDigitavel: string;
  /** `YYYY-MM-DD` — quando esta 2ª via foi tirada. */
  readonly emitidoEm: string;
}

/** Ponto de quebra da linha digitável: o espaço mais próximo do meio. */
function quebra(digitavel: string): number {
  const alvo = Math.floor(digitavel.length / 2);
  let melhor = -1;
  for (let i = 0; i < digitavel.length; i++) {
    if (digitavel[i] !== ' ') continue;
    if (melhor === -1 || Math.abs(i - alvo) < Math.abs(melhor - alvo)) melhor = i;
  }
  return melhor === -1 ? alvo : melhor; // sem espaço, parte no meio mesmo
}

function conteudo(d: DadosBoleto): string {
  const m = 40; // margem
  const dir = LARGURA - m;
  const ops: string[] = [];

  ops.push(
    texto(m, 790, 'F2', 16, 'SEGUNDA VIA DE BOLETO'),
    cinza(0.35),
    texto(m, 775, 'F1', 8, `Emitida em ${dataBr(d.emitidoEm)}`),
    preto,
  );

  ops.push(
    ...tarjaSimulado(
      m,
      dir,
      735,
      'Gerado pelo simulador do ERP. Nao tem valor de cobranca e nao e pagavel.',
    ),
  );

  // Ficha: cedente e nosso número, depois sacado, depois a linha do dinheiro.
  ops.push(caixa(m, 495, dir - m, 225));
  ops.push(...campo(m + 12, 705, 'Cedente', d.cedente));
  ops.push(...campo(dir - 170, 705, 'Nosso número', d.nossoNumero));
  ops.push(linha(m, 680, dir, 680, 0.4));

  ops.push(...campo(m + 12, 665, 'Sacado', d.sacado));
  ops.push(...campo(dir - 170, 665, 'CPF/CNPJ', d.sacadoCpf));
  ops.push(linha(m, 640, dir, 640, 0.4));

  ops.push(...campo(m + 12, 625, 'Contrato', d.contrato));
  ops.push(...campo(m + 180, 625, 'Parcela', d.parcela));
  ops.push(...campo(dir - 170, 625, 'Vencimento', dataBr(d.vencimento)));
  ops.push(linha(m, 600, dir, 600, 0.4));

  ops.push(...campo(m + 12, 585, 'Valor do documento', `R$ ${reais(d.valorReais)}`, 14));
  ops.push(linha(m, 555, dir, 555, 0.4));

  // Linha digitável: Courier porque é o que se confere dígito a dígito. Quebra
  // em duas para caber na largura sem encolher a fonte a ponto de o cotista não
  // conseguir ler na tela do celular — e quebra NO ESPAÇO mais próximo do meio,
  // porque partir um grupo de dígitos ao meio é justamente o que faz alguém
  // digitar errado.
  const meio = quebra(d.linhaDigitavel);
  ops.push(
    cinza(0.35),
    texto(m + 12, 540, 'F1', 6.5, 'LINHA DIGITÁVEL'),
    preto,
    texto(m + 12, 522, 'F3', 11, d.linhaDigitavel.slice(0, meio)),
    texto(m + 12, 506, 'F3', 11, d.linhaDigitavel.slice(meio).trimStart()),
  );

  ops.push(
    cinza(0.35),
    texto(m, 475, 'F1', 8, 'Este documento foi gerado automaticamente para demonstração do'),
    texto(m, 464, 'F1', 8, 'atendimento por WhatsApp. Nenhum código de barras real foi impresso.'),
    preto,
  );

  return ops.join('\n');
}

export function boletoPdf(d: DadosBoleto): Buffer {
  return montarPdf(conteudo(d));
}
