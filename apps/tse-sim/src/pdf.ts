/**
 * A máquina de PDF do simulador — extraída do `boleto-pdf.ts` da 040 quando a
 * 046 precisou desenhar um segundo documento (o contrato).
 *
 * Escrita à mão porque a stack é travada e nenhuma lib de PDF está nela. Um
 * PDF 1.4 de uma página é pequeno o bastante para isso ser honesto: catálogo,
 * páginas, página, conteúdo e três fontes-padrão (não embarcadas, logo sem
 * nenhum byte de fonte). O trabalho de verdade é a tabela `xref`, que é por
 * OFFSET DE BYTE — daí montar tudo em `Buffer` e medir, nunca em string.
 */

/** A4 em pontos, o tamanho que qualquer visualizador abre. */
export const LARGURA = 595;
export const ALTURA = 842;

/**
 * Texto dentro de `(...)`: só `\`, `(` e `)` precisam de escape. Fora do ASCII
 * o PDF lê os bytes conforme a `/Encoding` da fonte — WinAnsi, aqui, que é
 * latin-1 para tudo que o português usa.
 */
export function literal(s: string): string {
  return s.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
}

export function dataBr(iso: string): string {
  const [a, m, d] = iso.slice(0, 10).split('-');
  return d && m && a ? `${d}/${m}/${a}` : iso;
}

export function reais(v: number): string {
  return v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Operadores de conteúdo: texto, linha e retângulo. */
export const texto = (x: number, y: number, fonte: string, tam: number, s: string): string =>
  `BT /${fonte} ${tam} Tf ${x} ${y} Td (${literal(s)}) Tj ET`;

export const linha = (x1: number, y1: number, x2: number, y2: number, w = 0.7): string =>
  `${w} w ${x1} ${y1} m ${x2} ${y2} l S`;

export const caixa = (x: number, y: number, l: number, a: number, w = 0.7): string =>
  `${w} w ${x} ${y} ${l} ${a} re S`;

export const cinza = (t: number): string => `${t} ${t} ${t} rg`;
export const preto = '0 0 0 rg';

/** Rótulo pequeno + valor, o par que se repete em ficha de compensação e em contrato. */
export function campo(x: number, y: number, rotulo: string, valor: string, tam = 11): string[] {
  return [
    cinza(0.35),
    texto(x, y, 'F1', 6.5, rotulo.toUpperCase()),
    preto,
    texto(x, y - 13, 'F2', tam, valor),
  ];
}

/**
 * A tarja de documento simulado. Fica no topo, em caixa alta e com moldura,
 * porque estes PDFs vão parar no WhatsApp de alguém: um documento que PARECE
 * válido e não é seria pior do que documento nenhum.
 */
export function tarjaSimulado(m: number, dir: number, y: number, segundaLinha: string): string[] {
  return [
    cinza(0.9),
    `${m} ${y} ${dir - m} 28 re f`,
    preto,
    caixa(m, y, dir - m, 28, 1),
    texto(m + 10, y + 17, 'F2', 9, 'DOCUMENTO SIMULADO - AMBIENTE DE DEMONSTRACAO'),
    texto(m + 10, y + 6, 'F1', 8, segundaLinha),
  ];
}

/**
 * Monta o arquivo. Cada objeto entra no buffer na ordem, guardando o offset —
 * é isso que a `xref` publica, e é o que um PDF inválido erra primeiro.
 */
export function montarPdf(conteudo: string): Buffer {
  const fluxo = Buffer.from(conteudo, 'latin1');
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
