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
 * Contrato SINTÉTICO em PDF — 046.
 *
 * A 045 fecha a venda e o TSE devolve `IdContrato`, mas o comprador fica com um
 * NÚMERO e nada para assinar: a API do fornecedor não tem rota de documento de
 * contrato (as 90 da coleção cobrem cadastro, venda, financeiro, utilização e
 * operador). Como na 2ª via, o que falta é o papel — e o simulador faz o papel
 * do ERP, desenhando um a partir do que a venda gravou.
 *
 * O texto é resumo honesto, não minuta jurídica: partes, objeto, condições
 * financeiras e a nota de que a assinatura é eletrônica. Quem assina de verdade
 * é o cliente, com o contrato dele.
 */

export interface ParcelaContrato {
  /** "Entrada" / "Saldo" — como o ERP classifica em `tipoorigemcontafinanceira`. */
  readonly tipo: string;
  /** `YYYY-MM-DD`. */
  readonly vencimento: string;
  readonly valorReais: number;
}

export interface DadosContrato {
  readonly vendedora: string;
  readonly numeroContrato: string;
  /** `YYYY-MM-DD`. */
  readonly dataVenda: string;
  readonly compradorNome: string;
  readonly compradorCpf: string;
  readonly cotaCodigo: string;
  readonly tier: string;
  /** "TORRE 2 · apto 503 · até 6 hóspedes" — montado por quem lê o ERP. */
  readonly unidade: string;
  readonly periodos: number;
  readonly pontos: number;
  readonly valorTotalReais: number;
  readonly parcelas: readonly ParcelaContrato[];
  /** `YYYY-MM-DD` — quando esta via foi gerada. */
  readonly emitidoEm: string;
}

interface GrupoParcelas {
  readonly tipo: string;
  readonly periodo: string;
  readonly valor: string;
}

/**
 * O plano de pagamento, não o extrato. Um contrato de multipropriedade tem
 * dezenas ou centenas de parcelas — o 10001 do seed tem 124 —, e listar uma a
 * uma não cabe na página nem é o que um contrato diz: ele diz "entrada de X em
 * N vezes e saldo em M parcelas de Y". Agrupa por tipo, e só abre em linha
 * própria quando os valores de um mesmo tipo divergem entre si.
 */
function resumir(parcelas: readonly ParcelaContrato[]): GrupoParcelas[] {
  const grupos = new Map<string, ParcelaContrato[]>();
  for (const p of parcelas) {
    const atual = grupos.get(p.tipo);
    if (atual) atual.push(p);
    else grupos.set(p.tipo, [p]);
  }

  return [...grupos].map(([tipo, itens]) => {
    const ordenadas = [...itens].sort((a, b) => a.vencimento.localeCompare(b.vencimento));
    const primeira = ordenadas[0];
    const ultima = ordenadas[ordenadas.length - 1];
    if (!primeira || !ultima) return { tipo, periodo: '—', valor: '—' };

    const periodo =
      ordenadas.length === 1
        ? dataBr(primeira.vencimento)
        : `${dataBr(primeira.vencimento)} a ${dataBr(ultima.vencimento)}`;

    const iguais = ordenadas.every((p) => p.valorReais === primeira.valorReais);
    const total = ordenadas.reduce((t, p) => t + p.valorReais, 0);
    const valor = iguais
      ? `${ordenadas.length > 1 ? `${ordenadas.length}x ` : ''}R$ ${reais(primeira.valorReais)}`
      : `${ordenadas.length} parcelas · R$ ${reais(total)}`;

    return { tipo, periodo, valor };
  });
}

function conteudo(d: DadosContrato): string {
  const m = 40;
  const dir = LARGURA - m;
  const ops: string[] = [];

  ops.push(
    texto(m, 790, 'F2', 16, 'CONTRATO DE MULTIPROPRIEDADE'),
    cinza(0.35),
    texto(m, 775, 'F1', 8, `Contrato nº ${d.numeroContrato} · emitido em ${dataBr(d.emitidoEm)}`),
    preto,
  );

  ops.push(
    ...tarjaSimulado(
      m,
      dir,
      735,
      'Gerado pelo simulador do ERP. Nao tem validade juridica e nao vincula as partes.',
    ),
  );

  // 1. As partes
  ops.push(texto(m, 710, 'F2', 10, '1. PARTES'));
  ops.push(caixa(m, 630, dir - m, 62));
  ops.push(...campo(m + 12, 678, 'Vendedora', d.vendedora));
  ops.push(linha(m, 658, dir, 658, 0.4));
  ops.push(...campo(m + 12, 646, 'Compradora', d.compradorNome));
  ops.push(...campo(dir - 170, 646, 'CPF', d.compradorCpf));

  // 2. O objeto: a cota
  ops.push(texto(m, 605, 'F2', 10, '2. OBJETO'));
  ops.push(caixa(m, 500, dir - m, 87));
  ops.push(...campo(m + 12, 573, 'Cota', d.cotaCodigo));
  ops.push(...campo(m + 180, 573, 'Categoria', d.tier));
  ops.push(linha(m, 553, dir, 553, 0.4));
  ops.push(...campo(m + 12, 541, 'Unidade', d.unidade));
  ops.push(linha(m, 521, dir, 521, 0.4));
  ops.push(...campo(m + 12, 509, 'Períodos por ano', String(d.periodos)));
  ops.push(...campo(m + 180, 509, 'Pontos', d.pontos.toLocaleString('pt-BR')));

  // 3. O dinheiro
  ops.push(texto(m, 475, 'F2', 10, '3. CONDIÇÕES FINANCEIRAS'));
  ops.push(...campo(m + 12, 448, 'Valor total', `R$ ${reais(d.valorTotalReais)}`, 14));

  let y = 405;
  ops.push(
    cinza(0.35),
    texto(m + 12, y, 'F1', 6.5, 'CONDIÇÃO'),
    texto(m + 180, y, 'F1', 6.5, 'PERÍODO'),
    texto(dir - 140, y, 'F1', 6.5, 'VALOR'),
    preto,
  );
  ops.push(linha(m, y - 6, dir, y - 6, 0.4));
  for (const g of resumir(d.parcelas)) {
    y -= 20;
    ops.push(
      texto(m + 12, y, 'F2', 10, g.tipo),
      texto(m + 180, y, 'F2', 10, g.periodo),
      texto(dir - 140, y, 'F2', 10, g.valor),
    );
  }

  // 4. Assinatura — o contrato diz COMO se assina, porque é o passo seguinte
  const yAss = Math.max(y - 45, 150);
  ops.push(texto(m, yAss, 'F2', 10, '4. ASSINATURA'));
  ops.push(
    cinza(0.35),
    texto(
      m,
      yAss - 18,
      'F1',
      9,
      'Este contrato é assinado eletronicamente. O aceite registra data, hora e IP do',
    ),
    texto(m, yAss - 30, 'F1', 9, 'signatário, e a via assinada é devolvida pelo mesmo canal.'),
    texto(m, yAss - 50, 'F1', 8, `Venda registrada em ${dataBr(d.dataVenda)}.`),
    preto,
  );

  return ops.join('\n');
}

export function contratoPdf(d: DadosContrato): Buffer {
  return montarPdf(conteudo(d));
}
