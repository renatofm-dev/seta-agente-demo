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
 * Escrito à mão porque a stack é travada e nenhuma lib de PDF está nela. Um
 * PDF 1.4 de uma página é pequeno o bastante para isso ser honesto: catálogo,
 * páginas, página, conteúdo e três fontes-padrão (não embarcadas, logo sem
 * nenhum byte de fonte). O trabalho de verdade é a tabela `xref`, que é por
 * OFFSET DE BYTE — daí montar tudo em `Buffer` e medir, nunca em string.
 */

/** A4 em pontos, o tamanho de boleto que qualquer visualizador abre. */
const LARGURA = 595;
const ALTURA = 842;

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

/**
 * Texto dentro de `(...)`: só `\`, `(` e `)` precisam de escape. Fora do ASCII
 * o PDF lê os bytes conforme a `/Encoding` da fonte — WinAnsi, aqui, que é
 * latin-1 para tudo que o português usa.
 */
function literal(s: string): string {
  return s.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
}

function dataBr(iso: string): string {
  const [a, m, d] = iso.slice(0, 10).split('-');
  return d && m && a ? `${d}/${m}/${a}` : iso;
}

function reais(v: number): string {
  return v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Operadores de conteúdo: texto, linha e retângulo preenchido. */
const texto = (x: number, y: number, fonte: string, tam: number, s: string): string =>
  `BT /${fonte} ${tam} Tf ${x} ${y} Td (${literal(s)}) Tj ET`;

const linha = (x1: number, y1: number, x2: number, y2: number, w = 0.7): string =>
  `${w} w ${x1} ${y1} m ${x2} ${y2} l S`;

const caixa = (x: number, y: number, l: number, a: number, w = 0.7): string =>
  `${w} w ${x} ${y} ${l} ${a} re S`;

const cinza = (t: number): string => `${t} ${t} ${t} rg`;
const preto = '0 0 0 rg';

/** Ponto de quebra da linha digitável: o espaço mais próximo do meio. */
function quebra(linha: string): number {
  const alvo = Math.floor(linha.length / 2);
  let melhor = -1;
  for (let i = 0; i < linha.length; i++) {
    if (linha[i] !== ' ') continue;
    if (melhor === -1 || Math.abs(i - alvo) < Math.abs(melhor - alvo)) melhor = i;
  }
  return melhor === -1 ? alvo : melhor; // sem espaço, parte no meio mesmo
}

/** Rótulo pequeno + valor, o par que se repete em toda ficha de compensação. */
function campo(x: number, y: number, rotulo: string, valor: string, tam = 11): string[] {
  return [
    cinza(0.35),
    texto(x, y, 'F1', 6.5, rotulo.toUpperCase()),
    preto,
    texto(x, y - 13, 'F2', tam, valor),
  ];
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

  // A tarja. Fica no topo, em caixa alta e com moldura, porque este PDF vai
  // parar no WhatsApp de alguém: tem que ser óbvio que não se paga.
  ops.push(
    cinza(0.9),
    `${m} 735 ${dir - m} 28 re f`,
    preto,
    caixa(m, 735, dir - m, 28, 1),
    texto(m + 10, 752, 'F2', 9, 'DOCUMENTO SIMULADO - AMBIENTE DE DEMONSTRACAO'),
    texto(
      m + 10,
      741,
      'F1',
      8,
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

/**
 * Monta o arquivo. Cada objeto entra no buffer na ordem, guardando o offset —
 * é isso que a `xref` publica, e é o que um PDF inválido erra primeiro.
 */
export function boletoPdf(d: DadosBoleto): Buffer {
  const fluxo = Buffer.from(conteudo(d), 'latin1');
  const fonte = (nome: string) =>
    `<< /Type /Font /Subtype /Type1 /BaseFont /${nome} /Encoding /WinAnsiEncoding >>`;

  const objetos: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${LARGURA} ${ALTURA}] ` +
      '/Resources << /Font << /F1 5 0 R /F2 6 0 R /F3 7 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${fluxo.length} >>\nstream\n${fluxo.toString('latin1')}\nendstream`,
    fonte('Helvetica'),
    fonte('Helvetica-Bold'),
    fonte('Courier-Bold'),
  ];

  const partes: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];
  // comentário binário: convenção que faz ferramentas tratarem o arquivo como
  // binário e não reescreverem quebras de linha
  partes.push(Buffer.from('%\xE2\xE3\xCF\xD3\n', 'latin1'));
  const offsets: number[] = [];
  let posicao = partes.reduce((n, p) => n + p.length, 0);

  objetos.forEach((corpo, i) => {
    const bloco = Buffer.from(`${i + 1} 0 obj\n${corpo}\nendobj\n`, 'latin1');
    offsets.push(posicao);
    posicao += bloco.length;
    partes.push(bloco);
  });

  const inicioXref = posicao;
  const xref = [
    `xref\n0 ${objetos.length + 1}\n`,
    '0000000000 65535 f \n',
    ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`),
  ].join('');
  partes.push(Buffer.from(xref, 'latin1'));
  partes.push(
    Buffer.from(
      `trailer\n<< /Size ${objetos.length + 1} /Root 1 0 R >>\nstartxref\n${inicioXref}\n%%EOF\n`,
      'latin1',
    ),
  );

  return Buffer.concat(partes);
}
