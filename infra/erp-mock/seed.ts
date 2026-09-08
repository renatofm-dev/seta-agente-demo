import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { type Scalar, toPositional } from '@seta/erp-connector';
import pg from 'pg';

/**
 * Seed do erp_mock (TS Explorer simulado — spec 012, multipropriedade).
 * Proporções fiéis ao espelho `bali_tse` em escala reduzida: 2 torres, 30 UHs,
 * 400 cotas (≈57% bloqueio adm, ≈32% vendida, ≈11% disponível), 120 contratos
 * (≈58% cancelado, ≈40% ativo). Idempotente: aplica o schema SQL
 * (IF NOT EXISTS / DROP+CREATE) e recarrega os dados via TRUNCATE + insert em
 * uma transação. Datas relativas a now() para a demo nunca envelhecer.
 * Roda com credencial admin (dono do schema), nunca com erp_ro.
 */

const DIR = dirname(fileURLToPath(import.meta.url));

// RNG determinístico (mulberry32): mesmo conteúdo a cada rodada, só as datas deslizam.
function criarRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = criarRng(20260830);
const entre = (min: number, max: number) => min + Math.floor(rng() * (max - min + 1));
const escolher = <T>(arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)] as T;

function cpfValido(): string {
  const base: number[] = [];
  for (let i = 0; i < 9; i++) base.push(entre(0, 9));
  const dv = (nums: number[]) => {
    const soma = nums.reduce((acc, n, i) => acc + n * (nums.length + 1 - i), 0);
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };
  const d1 = dv(base);
  const d2 = dv([...base, d1]);
  const n = [...base, d1, d2].join('');
  return `${n.slice(0, 3)}.${n.slice(3, 6)}.${n.slice(6, 9)}-${n.slice(9)}`;
}

/** dias > 0 ⇒ passado; dias < 0 ⇒ futuro. */
function diasAtras(dias: number): string {
  const d = new Date(Date.now() - dias * 86_400_000);
  return d.toISOString().slice(0, 10);
}

const digitos = (n: number) => Array.from({ length: n }, () => entre(0, 9)).join('');

// ---------------------------------------------------------------------------
// Referências (nomes físicos em caixa alta, como no espelho)

const TORRES = ['TORRE 1', 'TORRE 2'] as const;

const GRUPOS_COTA = [
  'OURO PREMIUM',
  'OURO MASTER',
  'OURO SPECIAL',
  'DIAMANTE PREMIUM',
  'DIAMANTE MASTER',
  'DIAMANTE SPECIAL',
] as const;

const MODELOS_COTA: readonly (readonly [string, number])[] = [
  ['USO ANUAL 1 PERIODO', 1],
  ['USO ANUAL 2 PERIODOS', 2],
  ['USO ANUAL 3 PERIODOS', 3],
  ['USO BIENAL 1 PERIODO', 1],
];

/**
 * Preço de tabela (015) = base do tier × fator do modelo, em CENTAVOS e com
 * aritmética inteira (nada de float em dinheiro). PREMIUM > MASTER > SPECIAL;
 * DIAMANTE acima de OURO — a mesma ordem que a regra de pontos do seed usa.
 * Índice do array = idgrupocota/idmodelocota - 1.
 */
const BASE_TIER_CENTAVOS: readonly number[] = [
  6_200_000, // 1 OURO PREMIUM
  4_900_000, // 2 OURO MASTER
  3_900_000, // 3 OURO SPECIAL
  11_900_000, // 4 DIAMANTE PREMIUM
  9_600_000, // 5 DIAMANTE MASTER
  7_800_000, // 6 DIAMANTE SPECIAL
];

/** Percentual sobre a base: mais períodos de uso, mais caro; bienal vale menos. */
const FATOR_MODELO: readonly number[] = [
  100, // 1 USO ANUAL 1 PERIODO
  175, // 2 USO ANUAL 2 PERIODOS
  240, // 3 USO ANUAL 3 PERIODOS
  60, // 4 USO BIENAL 1 PERIODO
];

const MOTIVOS_CANCELAMENTO = [
  'DIFICULDADE FINANCEIRA',
  'INSATISFACAO COM O PRODUTO',
  'ARREPENDIMENTO NO PRAZO LEGAL',
  'PROBLEMAS DE SAUDE',
  'OUTROS',
] as const;

const MOTIVOS_CONTATO = [
  'COBRANCA',
  'SEGUNDA VIA DE BOLETO',
  'DUVIDA CONTRATUAL',
  'DISTRATO',
  'RECLAMACAO',
  'ELOGIO',
] as const;

const NOMES = [
  'Ana',
  'Bruno',
  'Carla',
  'Diego',
  'Elisa',
  'Fábio',
  'Gabriela',
  'Heitor',
  'Isabela',
  'João',
  'Karina',
  'Lucas',
  'Mariana',
  'Nelson',
  'Otávia',
  'Paulo',
  'Renata',
  'Sérgio',
  'Tatiana',
  'Vicente',
] as const;

const SOBRENOMES = [
  'Almeida',
  'Barbosa',
  'Cardoso',
  'Duarte',
  'Esteves',
  'Ferreira',
  'Gonçalves',
  'Henriques',
  'Lima',
  'Machado',
  'Nogueira',
  'Oliveira',
  'Pereira',
  'Queiroz',
  'Ribeiro',
  'Santos',
  'Teixeira',
  'Vasconcelos',
] as const;

// contratos demo (fixos, fora do RNG): vinculados em configs/demo/contatos.yaml
export const CONTRATO_DEMO_EM_DIA = 10_001; // ativo, parcelas em dia
export const CONTRATO_DEMO_INADIMPLENTE = 10_002; // ativo, parcelas vencidas
export const CONTRATO_DEMO_DISTRATO = 10_003; // cancelado, distrato em análise

// ---------------------------------------------------------------------------
// Infra de escrita (binds nomeados, sem interpolação de valores)

type Row = Record<string, Scalar>;

async function inserirLote(
  client: pg.PoolClient,
  tabela: string,
  colunas: readonly string[],
  rows: readonly Row[],
): Promise<void> {
  const TAMANHO = 200;
  for (let i = 0; i < rows.length; i += TAMANHO) {
    const lote = rows.slice(i, i + TAMANHO);
    const binds: Row = {};
    const tuplas = lote.map((row, r) => {
      const tokens = colunas.map((col) => {
        const nome = `${col}_${r}`;
        binds[nome] = row[col] ?? null;
        return `:${nome}`;
      });
      return `(${tokens.join(', ')})`;
    });
    const sql = `INSERT INTO ${tabela} (${colunas.join(', ')}) VALUES ${tuplas.join(', ')}`;
    const { text, values } = toPositional(sql, binds);
    await client.query({ text, values: values as Scalar[] });
  }
}

// ---------------------------------------------------------------------------
// Etapas

export async function applySchema(pool: pg.Pool): Promise<void> {
  const arquivos = readdirSync(DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const arquivo of arquivos) {
    await pool.query(readFileSync(join(DIR, arquivo), 'utf-8'));
  }
}

export interface SeedResumo {
  readonly cotas: number;
  readonly precos: number;
  readonly pessoas: number;
  readonly contratos: number;
  readonly titulos: number;
  readonly cancelamentos: number;
  readonly chamados: number;
}

interface ContratoSeed {
  readonly idcontrato: number;
  readonly idpessoatitular: number;
  readonly idcota: number;
  readonly statuscontrato: 'ATIVO' | 'ATIVOREV' | 'CANCELADO' | 'QUITADO';
  readonly datavendaDias: number; // dias atrás
  /** 'em_dia' paga tudo vencido; nº > 0 deixa as N últimas vencidas sem pagar. */
  readonly parcelasVencidasAbertas: number;
  readonly parcelasSaldo: number;
}

export async function seedData(pool: pg.Pool): Promise<SeedResumo> {
  // --- estrutura hoteleira: 2 torres × 5 andares × 3 UHs = 30 UHs
  const edificios: Row[] = TORRES.map((nome, i) => ({ idedificiohotel: i + 1, nome }));
  const uhs: Row[] = [];
  let idUh = 0;
  for (let torre = 1; torre <= 2; torre++) {
    for (let andar = 1; andar <= 5; andar++) {
      for (let pos = 1; pos <= 3; pos++) {
        idUh++;
        uhs.push({
          idunidadehoteleira: idUh,
          idedificiohotel: torre,
          numero: `${andar}${String(pos).padStart(2, '0')}`,
          andar,
          capacidade: escolher([4, 6, 8] as const),
        });
      }
    }
  }

  const grupos: Row[] = GRUPOS_COTA.map((nome, i) => ({ idgrupocota: i + 1, nome }));
  const modelos: Row[] = MODELOS_COTA.map(([nome, qtd], i) => ({
    idmodelocota: i + 1,
    nome,
    qtdperiodos: qtd,
  }));

  // --- tabela de preço: 6 tiers × 4 modelos = 24 combinações (015)
  const precos: Row[] = [];
  for (let g = 1; g <= GRUPOS_COTA.length; g++) {
    for (let m = 1; m <= MODELOS_COTA.length; m++) {
      precos.push({
        idgrupocota: g,
        idmodelocota: m,
        valorcentavos:
          ((BASE_TIER_CENTAVOS[g - 1] as number) * (FATOR_MODELO[m - 1] as number)) / 100,
      });
    }
  }

  // --- 400 cotas nas proporções do espelho; as 3 primeiras são das demos
  const N_COTAS = 400;
  const statusCotas: string[] = [];
  for (let i = 0; i < N_COTAS; i++) {
    statusCotas.push(i < 228 ? 'BLOQUEIOADMINISTRATIVO' : i < 228 + 128 ? 'VENDIDA' : 'DISPONIVEL');
  }
  // embaralha determinístico (Fisher–Yates com o rng do seed)
  for (let i = statusCotas.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [statusCotas[i], statusCotas[j]] = [statusCotas[j] as string, statusCotas[i] as string];
  }
  // as cotas 1-3 são das demos e precisam estar VENDIDAS — troca (swap) para
  // não alterar as contagens por status
  for (let i = 0; i < 3; i++) {
    if (statusCotas[i] === 'VENDIDA') continue;
    const j = statusCotas.findIndex((s, k) => k > 2 && s === 'VENDIDA');
    [statusCotas[i], statusCotas[j]] = [statusCotas[j] as string, statusCotas[i] as string];
  }
  const cotas: Row[] = Array.from({ length: N_COTAS }, (_, i) => {
    const uh = uhs[i % uhs.length] as Row;
    return {
      idcotauh: i + 1,
      idunidadehoteleira: uh.idunidadehoteleira as number,
      idgrupocota: entre(1, GRUPOS_COTA.length),
      idmodelocota: entre(1, MODELOS_COTA.length),
      codigocota: `C${uh.numero}-${String(i + 1).padStart(3, '0')}`,
      statuscota: statusCotas[i] as string,
    };
  });
  // cotas das demos: tier/UH conhecidos (torre 2 cobertura p/ 10001)
  Object.assign(cotas[0] as Row, {
    idunidadehoteleira: 30,
    idgrupocota: 4, // DIAMANTE PREMIUM
    idmodelocota: 2, // 2 períodos
  });
  Object.assign(cotas[1] as Row, {
    idunidadehoteleira: 7,
    idgrupocota: 2, // OURO MASTER
    idmodelocota: 1,
  });
  Object.assign(cotas[2] as Row, {
    idunidadehoteleira: 12,
    idgrupocota: 3, // OURO SPECIAL
    idmodelocota: 4,
  });
  const cotasVendidas = cotas
    .filter((c) => c.statuscota === 'VENDIDA')
    .map((c) => c.idcotauh as number);

  // --- pessoas (dado REAL na física; o produto só vê a v_cotista pseudonimizada)
  const N_PESSOAS = 130;
  const pessoas: Row[] = Array.from({ length: N_PESSOAS }, (_, i) => {
    const nome = `${escolher(NOMES)} ${escolher(SOBRENOMES)} ${escolher(SOBRENOMES)}`;
    return {
      idpessoa: i + 1,
      nome,
      cpf: cpfValido(),
      email: `${nome.split(' ')[0]?.toLowerCase()}.${i + 1}@exemplo.com.br`,
    };
  });

  // --- contratos: 3 demos fixos + 117 nas proporções do espelho
  const contratosSeed: ContratoSeed[] = [
    {
      idcontrato: CONTRATO_DEMO_EM_DIA,
      idpessoatitular: 1,
      idcota: 1,
      statuscontrato: 'ATIVO',
      datavendaDias: 700,
      parcelasVencidasAbertas: 0,
      parcelasSaldo: 120,
    },
    {
      idcontrato: CONTRATO_DEMO_INADIMPLENTE,
      idpessoatitular: 2,
      idcota: 2,
      statuscontrato: 'ATIVO',
      datavendaDias: 500,
      parcelasVencidasAbertas: 3,
      parcelasSaldo: 100,
    },
    {
      idcontrato: CONTRATO_DEMO_DISTRATO,
      idpessoatitular: 3,
      idcota: 3,
      statuscontrato: 'CANCELADO',
      datavendaDias: 900,
      parcelasVencidasAbertas: 0,
      parcelasSaldo: 60,
    },
  ];
  const N_BULK = 117;
  for (let i = 0; i < N_BULK; i++) {
    const sorteio = rng();
    const statuscontrato =
      sorteio < 0.58
        ? 'CANCELADO'
        : sorteio < 0.98
          ? rng() < 0.8
            ? 'ATIVO'
            : 'ATIVOREV'
          : 'QUITADO';
    contratosSeed.push({
      idcontrato: 10_101 + i,
      idpessoatitular: entre(4, N_PESSOAS),
      idcota: escolher(cotasVendidas),
      statuscontrato,
      datavendaDias: entre(200, 2500),
      parcelasVencidasAbertas: statuscontrato.startsWith('ATIVO') && rng() < 0.25 ? entre(1, 6) : 0,
      // o crediário do espelho chega a 583 parcelas — o 1º contrato bulk carrega o extremo
      parcelasSaldo: i === 0 ? 583 : entre(24, 120),
    });
  }

  const contratos: Row[] = contratosSeed.map((c) => ({
    idcontrato: c.idcontrato,
    numerocontrato: String(c.idcontrato),
    idpessoatitular: c.idpessoatitular,
    idcotaadquirida: c.idcota,
    // fallback do espelho: parte dos contratos não tem cota ativa preenchida
    // (o 10001 exercita o fallback na própria demo); ~10% migraram de cota
    idcotaativa:
      c.idcontrato === CONTRATO_DEMO_EM_DIA || rng() < 0.2
        ? null
        : rng() < 0.12
          ? escolher(cotasVendidas)
          : c.idcota,
    statuscontrato: c.statuscontrato,
    datavenda: diasAtras(c.datavendaDias),
    // pontos acompanham o tier da cota adquirida (DIAMANTE = grupos 4-6)
    qtdpontos:
      (((cotas[c.idcota - 1] as Row).idgrupocota as number) > 3 ? entre(60, 90) : entre(20, 50)) *
      1000,
  }));

  const origens: Row[] = [
    { idtipoorigemcontafinanceira: 1, nome: 'ENTRADA' },
    { idtipoorigemcontafinanceira: 2, nome: 'SALDO' },
  ];
  const meios: Row[] = [
    { idmeiopagamento: 1, nome: 'BOLETO' },
    { idmeiopagamento: 2, nome: 'PIX' },
    { idmeiopagamento: 3, nome: 'CARTAORECORRENTE' },
  ];

  // --- parcelas (Entrada + Saldo) por contrato
  const titulos: Row[] = [];
  let idTitulo = 0;
  const pushParcela = (t: Row) => {
    idTitulo++;
    titulos.push({ idcontafinanceira: idTitulo, ...t });
  };

  // meio predominante fixo nos demos (boleto tem linha digitável p/ o roteiro)
  const MEIO_DEMO: Record<number, number> = {
    [CONTRATO_DEMO_EM_DIA]: 1,
    [CONTRATO_DEMO_INADIMPLENTE]: 1,
    [CONTRATO_DEMO_DISTRATO]: 3,
  };
  for (const c of contratosSeed) {
    // meio de pagamento predominante do contrato, na proporção do espelho
    const sorteioMeio = rng();
    const idmeio = MEIO_DEMO[c.idcontrato] ?? (sorteioMeio < 0.5 ? 1 : sorteioMeio < 0.85 ? 3 : 2);
    const nEntrada = entre(1, 10);
    const valorEntrada = entre(1_500, 5_000);
    const valorSaldo = entre(800, 2_500);
    // cancelados: parcelas depois do distrato saem do histórico ATIVO
    const corteCancelado =
      c.statuscontrato === 'CANCELADO' ? entre(6, Math.max(7, c.parcelasSaldo - 6)) : null;

    const gerar = (origem: 1 | 2, n: number, valor: number, offsetMeses: number) => {
      // quantas parcelas desta série já venceram; as últimas
      // `parcelasVencidasAbertas` do saldo ficam sem pagamento (inadimplência)
      const vencidas = Math.min(n, Math.max(0, Math.ceil(c.datavendaDias / 30 - offsetMeses) - 1));
      const pagaveis = origem === 2 ? Math.max(0, vencidas - c.parcelasVencidasAbertas) : vencidas;
      for (let p = 1; p <= n; p++) {
        const vencDias = c.datavendaDias - 30 * (p + offsetMeses);
        const venceu = vencDias > 0;
        const posCorte = corteCancelado !== null && origem === 2 && p > corteCancelado;
        const emAberto = venceu && p > pagaveis;
        const paga = venceu && !posCorte && !emAberto;
        const recorrente = idmeio === 3;
        pushParcela({
          idcontrato: c.idcontrato,
          idtipoorigemcontafinanceira: origem,
          idmeiopagamento: idmeio,
          numeroparcela: p,
          qtdparcelas: n,
          valorreceber: valor,
          valorrecebido: paga ? valor : null,
          // regra auditada no espelho: a origem REESCREVE datavencimento da
          // recorrente paga (empurra p/ a próxima cobrança); a referência
          // confiável é datavencimentorecorrencia
          datavencimento: recorrente && paga ? diasAtras(vencDias - 30) : diasAtras(vencDias),
          datavencimentorecorrencia: recorrente ? diasAtras(vencDias) : null,
          datarecebimento: paga ? diasAtras(Math.max(0, vencDias - entre(-2, 3))) : null,
          tipohistorico: posCorte ? 'CANCELADO' : 'ATIVO',
          linhadigitavel: idmeio === 1 && !paga ? digitos(47) : null,
          pixcopiaecola:
            !paga && idmeio !== 3 ? `00020126580014br.gov.bcb.pix${digitos(40)}` : null,
        });
      }
    };
    gerar(1, nEntrada, valorEntrada, 0);
    gerar(2, c.parcelasSaldo, valorSaldo, nEntrada);
  }

  // linhas que provam as regras da v_titulo (ids fixos, usados nos testes):
  // 1-2) vencimento de referência fora da janela de sanidade ⇒ fora da view
  pushParcela({
    idcontrato: CONTRATO_DEMO_INADIMPLENTE,
    idtipoorigemcontafinanceira: 2,
    idmeiopagamento: 1,
    numeroparcela: 998,
    qtdparcelas: 998,
    valorreceber: 1_000,
    valorrecebido: null,
    datavencimento: '3035-01-01',
    datavencimentorecorrencia: null,
    datarecebimento: null,
    tipohistorico: 'ATIVO',
    linhadigitavel: digitos(47),
    pixcopiaecola: null,
  });
  pushParcela({
    idcontrato: CONTRATO_DEMO_INADIMPLENTE,
    idtipoorigemcontafinanceira: 2,
    idmeiopagamento: 3,
    numeroparcela: 999,
    qtdparcelas: 999,
    valorreceber: 1_000,
    valorrecebido: null,
    datavencimento: diasAtras(30),
    datavencimentorecorrencia: '1900-01-01',
    datarecebimento: null,
    tipohistorico: 'ATIVO',
    linhadigitavel: null,
    pixcopiaecola: null,
  });
  // 3) recorrente NÃO paga com datavencimento reescrito p/ o futuro: o cru
  // diria "aberto"; a referência (recorrência) diz VENCIDO há 40 dias
  pushParcela({
    idcontrato: CONTRATO_DEMO_INADIMPLENTE,
    idtipoorigemcontafinanceira: 2,
    idmeiopagamento: 3,
    numeroparcela: 997,
    qtdparcelas: 997,
    valorreceber: 1_200,
    valorrecebido: null,
    datavencimento: diasAtras(-20),
    datavencimentorecorrencia: diasAtras(40),
    datarecebimento: null,
    tipohistorico: 'ATIVO',
    linhadigitavel: null,
    pixcopiaecola: null,
  });

  // --- distratos: todo CANCELADO tem pelo menos um; o demo tem histórico duplo
  const motivosCancel: Row[] = MOTIVOS_CANCELAMENTO.map((descricao, i) => ({
    idmotivocancelamentocontrato: i + 1,
    descricao,
  }));
  const cancelamentos: Row[] = [];
  let idCancel = 0;
  for (const c of contratosSeed) {
    if (c.statuscontrato !== 'CANCELADO') continue;
    if (c.idcontrato === CONTRATO_DEMO_DISTRATO) continue; // tratado abaixo
    const sorteio = rng();
    cancelamentos.push({
      idcancelamento: ++idCancel,
      idcontrato: c.idcontrato,
      idmotivocancelamentocontrato: entre(1, MOTIVOS_CANCELAMENTO.length),
      statuscancelamento: sorteio < 0.3 ? 'EMANALISE' : sorteio < 0.9 ? 'CONCLUIDO' : 'NEGADO',
      datasolicitacao: diasAtras(entre(10, c.datavendaDias - 60)),
      valormulta: entre(3_000, 15_000),
      valorreembolso: entre(0, 25_000),
    });
  }
  // demo: pedido antigo NEGADO + pedido atual EM ANÁLISE (v_cancelamento pega o último)
  cancelamentos.push(
    {
      idcancelamento: ++idCancel,
      idcontrato: CONTRATO_DEMO_DISTRATO,
      idmotivocancelamentocontrato: 2,
      statuscancelamento: 'NEGADO',
      datasolicitacao: diasAtras(400),
      valormulta: 6_000,
      valorreembolso: 0,
    },
    {
      idcancelamento: ++idCancel,
      idcontrato: CONTRATO_DEMO_DISTRATO,
      idmotivocancelamentocontrato: 1, // DIFICULDADE FINANCEIRA
      statuscancelamento: 'EMANALISE',
      datasolicitacao: diasAtras(20),
      valormulta: 8_500,
      valorreembolso: 12_750,
    },
  );

  // --- chamados de atendimento
  const motivosContato: Row[] = MOTIVOS_CONTATO.map((descricao, i) => ({
    idmotivocontato: i + 1,
    descricao,
  }));
  const chamados: Row[] = [];
  let idChamado = 0;
  const pushChamado = (t: Omit<Row, 'idocorrenciaatendimentots'>) => {
    idChamado++;
    chamados.push({ idocorrenciaatendimentots: idChamado, ...t });
  };
  // demos: 10001 finalizado, 10002 aberto (cobrança), 10003 em andamento (distrato)
  pushChamado({
    idpessoa: 1,
    idmotivocontato: 3,
    statusocorrencia: 'FINALIZADA',
    dataabertura: diasAtras(90),
    datafinalizacao: diasAtras(88),
  });
  pushChamado({
    idpessoa: 2,
    idmotivocontato: 2,
    statusocorrencia: 'ABERTA',
    dataabertura: diasAtras(5),
    datafinalizacao: null,
  });
  pushChamado({
    idpessoa: 3,
    idmotivocontato: 4,
    statusocorrencia: 'EMANDAMENTO',
    dataabertura: diasAtras(18),
    datafinalizacao: null,
  });
  for (let i = 0; i < 40; i++) {
    const contrato = escolher(contratosSeed);
    const aberturaDias = entre(2, 300);
    const finalizada = rng() < 0.7;
    pushChamado({
      idpessoa: contrato.idpessoatitular,
      idmotivocontato: entre(1, MOTIVOS_CONTATO.length),
      statusocorrencia: finalizada ? 'FINALIZADA' : rng() < 0.5 ? 'ABERTA' : 'EMANDAMENTO',
      dataabertura: diasAtras(aberturaDias),
      datafinalizacao: finalizada ? diasAtras(entre(0, aberturaDias - 1)) : null,
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'TRUNCATE contafinanceira, cancelamento, ocorrenciaatendimentots, contrato, cotauh, ' +
        'tabelapreco, pessoa, unidadehoteleira, edificiohotel, grupocota, modelocota, ' +
        'tipoorigemcontafinanceira, meiopagamento, motivocancelamentocontrato, motivocontato',
    );
    await inserirLote(client, 'edificiohotel', ['idedificiohotel', 'nome'], edificios);
    await inserirLote(
      client,
      'unidadehoteleira',
      ['idunidadehoteleira', 'idedificiohotel', 'numero', 'andar', 'capacidade'],
      uhs,
    );
    await inserirLote(client, 'grupocota', ['idgrupocota', 'nome'], grupos);
    await inserirLote(client, 'modelocota', ['idmodelocota', 'nome', 'qtdperiodos'], modelos);
    await inserirLote(
      client,
      'tabelapreco',
      ['idgrupocota', 'idmodelocota', 'valorcentavos'],
      precos,
    );
    await inserirLote(
      client,
      'cotauh',
      ['idcotauh', 'idunidadehoteleira', 'idgrupocota', 'idmodelocota', 'codigocota', 'statuscota'],
      cotas,
    );
    await inserirLote(client, 'pessoa', ['idpessoa', 'nome', 'cpf', 'email'], pessoas);
    await inserirLote(
      client,
      'contrato',
      [
        'idcontrato',
        'numerocontrato',
        'idpessoatitular',
        'idcotaadquirida',
        'idcotaativa',
        'statuscontrato',
        'datavenda',
        'qtdpontos',
      ],
      contratos,
    );
    await inserirLote(
      client,
      'tipoorigemcontafinanceira',
      ['idtipoorigemcontafinanceira', 'nome'],
      origens,
    );
    await inserirLote(client, 'meiopagamento', ['idmeiopagamento', 'nome'], meios);
    await inserirLote(
      client,
      'contafinanceira',
      [
        'idcontafinanceira',
        'idcontrato',
        'idtipoorigemcontafinanceira',
        'idmeiopagamento',
        'numeroparcela',
        'qtdparcelas',
        'valorreceber',
        'valorrecebido',
        'datavencimento',
        'datavencimentorecorrencia',
        'datarecebimento',
        'tipohistorico',
        'linhadigitavel',
        'pixcopiaecola',
      ],
      titulos,
    );
    await inserirLote(
      client,
      'motivocancelamentocontrato',
      ['idmotivocancelamentocontrato', 'descricao'],
      motivosCancel,
    );
    await inserirLote(
      client,
      'cancelamento',
      [
        'idcancelamento',
        'idcontrato',
        'idmotivocancelamentocontrato',
        'statuscancelamento',
        'datasolicitacao',
        'valormulta',
        'valorreembolso',
      ],
      cancelamentos,
    );
    await inserirLote(client, 'motivocontato', ['idmotivocontato', 'descricao'], motivosContato);
    await inserirLote(
      client,
      'ocorrenciaatendimentots',
      [
        'idocorrenciaatendimentots',
        'idpessoa',
        'idmotivocontato',
        'statusocorrencia',
        'dataabertura',
        'datafinalizacao',
      ],
      chamados,
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  return {
    cotas: cotas.length,
    precos: precos.length,
    pessoas: pessoas.length,
    contratos: contratos.length,
    titulos: titulos.length,
    cancelamentos: cancelamentos.length,
    chamados: chamados.length,
  };
}

export function adminUrl(): string {
  return process.env.ERP_MOCK_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5432/erp_mock';
}

async function main(): Promise<void> {
  const pool = new pg.Pool({ connectionString: adminUrl(), max: 2 });
  try {
    await applySchema(pool);
    const resumo = await seedData(pool);
    console.log('seed erp_mock ok:', JSON.stringify(resumo));
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
