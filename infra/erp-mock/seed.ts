import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { type Scalar, toPositional } from '@seta/erp-connector';
import pg from 'pg';

/**
 * Seed do erp_mock (TS Explorer simulado). Idempotente: aplica o schema SQL
 * (IF NOT EXISTS / OR REPLACE) e recarrega os dados via TRUNCATE + insert em
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

const rng = criarRng(20260826);
const entre = (min: number, max: number) => min + Math.floor(rng() * (max - min + 1));
const escolher = <T>(arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)] as T;

function cnpjValido(): string {
  const base: number[] = [];
  for (let i = 0; i < 8; i++) base.push(entre(0, 9));
  base.push(0, 0, 0, 1); // filial 0001
  const dv = (nums: number[], pesos: number[]) => {
    const soma = nums.reduce((acc, n, i) => acc + n * (pesos[i] as number), 0);
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };
  const p1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const p2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const d1 = dv(base, p1);
  const d2 = dv([...base, d1], p2);
  const n = [...base, d1, d2].join('');
  return `${n.slice(0, 2)}.${n.slice(2, 5)}.${n.slice(5, 8)}/${n.slice(8, 12)}-${n.slice(12)}`;
}

function diasAtras(dias: number): string {
  const d = new Date(Date.now() - dias * 86_400_000);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Dados

const NOMES_CLIENTE: readonly (readonly [string, string])[] = [
  ['Comercial Andrade de Bebidas Ltda', 'Depósito do Andrade'],
  ['Distribuidora Vale do Ipê Ltda', 'Vale do Ipê'],
  ['Bar e Mercearia Dois Irmãos Ltda', 'Dois Irmãos'],
  ['Supermercado Bom Preço da Serra Ltda', 'Bom Preço'],
  ['Adega Santa Clara Comércio Ltda', 'Adega Santa Clara'],
  ['Restaurante e Choperia Central Ltda', 'Choperia Central'],
  ['Conveniência 24h do Posto Azul Ltda', 'Conveniência Azul'],
  ['Atacadão da Bebida Norte Ltda', 'Atacadão Norte'],
  ['Empório São Jorge Alimentos Ltda', 'Empório São Jorge'],
  ['Padaria e Lanchonete Estrela Ltda', 'Padaria Estrela'],
  ['Mercadinho da Vila Nova Ltda', 'Mercadinho da Vila'],
  ['Distribuidora Rio Claro Bebidas Ltda', 'Rio Claro Bebidas'],
  ['Casa de Carnes e Bar do Zé Ltda', 'Bar do Zé'],
  ['Hotel Fazenda Recanto Verde Ltda', 'Recanto Verde'],
  ['Pizzaria Forno a Lenha Ltda', 'Forno a Lenha'],
  ['Clube Recreativo Primavera', 'Clube Primavera'],
  ['Mercado Popular do Centro Ltda', 'Mercado Popular'],
  ['Distribuidora Águas Claras Ltda', 'Águas Claras'],
  ['Buffet e Eventos Alegria Ltda', 'Buffet Alegria'],
  ['Quiosque Praia do Sol Ltda', 'Quiosque do Sol'],
];

interface ProdutoSeed {
  readonly descricao: string;
  readonly embalagem: string;
  readonly unidade: string;
  readonly preco: number; // R$ por embalagem
}

const PRODUTOS: readonly ProdutoSeed[] = [
  { descricao: 'Cerveja Pilsen Lata 350ml', embalagem: 'CX 12', unidade: 'CX', preco: 42.9 },
  { descricao: 'Cerveja Pilsen Long Neck 330ml', embalagem: 'CX 24', unidade: 'CX', preco: 118.8 },
  {
    descricao: 'Cerveja Puro Malte Garrafa 600ml',
    embalagem: 'CX 24',
    unidade: 'CX',
    preco: 189.6,
  },
  { descricao: 'Cerveja IPA Artesanal Lata 473ml', embalagem: 'CX 6', unidade: 'CX', preco: 89.4 },
  { descricao: 'Cerveja Zero Álcool Lata 350ml', embalagem: 'CX 12', unidade: 'CX', preco: 46.8 },
  { descricao: 'Chopp Pilsen Barril 30L', embalagem: 'UN', unidade: 'UN', preco: 389.0 },
  { descricao: 'Chopp Vinho Barril 30L', embalagem: 'UN', unidade: 'UN', preco: 459.0 },
  { descricao: 'Refrigerante Cola 2L', embalagem: 'FD 6', unidade: 'FD', preco: 53.4 },
  { descricao: 'Refrigerante Cola Lata 350ml', embalagem: 'CX 12', unidade: 'CX', preco: 38.28 },
  { descricao: 'Refrigerante Guaraná 2L', embalagem: 'FD 6', unidade: 'FD', preco: 47.4 },
  { descricao: 'Refrigerante Guaraná Lata 350ml', embalagem: 'CX 12', unidade: 'CX', preco: 33.48 },
  { descricao: 'Refrigerante Laranja 2L', embalagem: 'FD 6', unidade: 'FD', preco: 44.94 },
  { descricao: 'Refrigerante Limão Lata 350ml', embalagem: 'CX 12', unidade: 'CX', preco: 32.28 },
  { descricao: 'Refrigerante Cola Zero 2L', embalagem: 'FD 6', unidade: 'FD', preco: 53.4 },
  { descricao: 'Água Mineral sem Gás 500ml', embalagem: 'FD 12', unidade: 'FD', preco: 14.28 },
  { descricao: 'Água Mineral com Gás 500ml', embalagem: 'FD 12', unidade: 'FD', preco: 16.68 },
  { descricao: 'Água Mineral Galão 20L', embalagem: 'UN', unidade: 'UN', preco: 12.9 },
  { descricao: 'Água Tônica Lata 350ml', embalagem: 'CX 12', unidade: 'CX', preco: 40.68 },
  {
    descricao: 'Energético Tradicional Lata 250ml',
    embalagem: 'CX 24',
    unidade: 'CX',
    preco: 158.16,
  },
  { descricao: 'Energético Zero Lata 250ml', embalagem: 'CX 24', unidade: 'CX', preco: 158.16 },
  { descricao: 'Isotônico Sabor Laranja 500ml', embalagem: 'CX 6', unidade: 'CX', preco: 29.94 },
  { descricao: 'Suco de Uva Integral 1,5L', embalagem: 'CX 6', unidade: 'CX', preco: 101.4 },
  { descricao: 'Suco de Laranja Integral 900ml', embalagem: 'CX 12', unidade: 'CX', preco: 118.8 },
  { descricao: 'Suco de Pêssego Lata 335ml', embalagem: 'CX 12', unidade: 'CX', preco: 45.48 },
  { descricao: 'Chá Mate Limão 1,5L', embalagem: 'CX 6', unidade: 'CX', preco: 41.94 },
  { descricao: 'Chá Verde com Limão Lata 340ml', embalagem: 'CX 12', unidade: 'CX', preco: 43.08 },
  { descricao: 'Vinho Tinto Seco Nacional 750ml', embalagem: 'CX 6', unidade: 'CX', preco: 155.4 },
  {
    descricao: 'Vinho Branco Suave Nacional 750ml',
    embalagem: 'CX 6',
    unidade: 'CX',
    preco: 149.4,
  },
  { descricao: 'Espumante Brut Nacional 750ml', embalagem: 'CX 6', unidade: 'CX', preco: 227.4 },
  { descricao: 'Vodka Nacional 1L', embalagem: 'CX 12', unidade: 'CX', preco: 275.4 },
  { descricao: 'Cachaça Prata 965ml', embalagem: 'CX 12', unidade: 'CX', preco: 154.68 },
  { descricao: 'Cachaça Ouro Envelhecida 700ml', embalagem: 'CX 12', unidade: 'CX', preco: 238.8 },
  { descricao: 'Whisky Blended 8 Anos 1L', embalagem: 'CX 12', unidade: 'CX', preco: 1078.8 },
  { descricao: 'Gin London Dry Nacional 750ml', embalagem: 'CX 6', unidade: 'CX', preco: 359.4 },
  { descricao: 'Aperitivo de Bitter 900ml', embalagem: 'CX 6', unidade: 'CX', preco: 233.4 },
  { descricao: 'Refresco em Pó Sabor Uva 25g', embalagem: 'CX 15', unidade: 'CX', preco: 17.85 },
  { descricao: 'Gelo em Cubos Pacote 5kg', embalagem: 'UN', unidade: 'UN', preco: 11.5 },
  { descricao: 'Carvão Vegetal 3kg', embalagem: 'UN', unidade: 'UN', preco: 15.9 },
  { descricao: 'Copo Descartável 300ml', embalagem: 'CX 20', unidade: 'CX', preco: 74.0 },
  { descricao: 'Água de Coco 1L', embalagem: 'CX 12', unidade: 'CX', preco: 106.8 },
];

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
  readonly clientes: number;
  readonly produtos: number;
  readonly pedidos: number;
  readonly itens: number;
  readonly titulos: number;
}

export async function seedData(pool: pg.Pool): Promise<SeedResumo> {
  const clientes: Row[] = NOMES_CLIENTE.map(([razao, fantasia], i) => ({
    codcli: i + 1,
    cgcent: cnpjValido(),
    cliente: razao,
    fantasia,
    dtcad: diasAtras(entre(180, 1500)),
    bloqueio: 'N',
  }));

  const produtos: Row[] = PRODUTOS.map((p, i) => ({
    codprod: 1001 + i,
    descricao: p.descricao,
    embalagem: p.embalagem,
    unidade: p.unidade,
    codauxiliar: String(7890000000000 + entre(100000, 999999)),
  }));

  const precos: Row[] = PRODUTOS.map((p, i) => ({
    numregiao: 1,
    codprod: 1001 + i,
    pvenda: p.preco,
    dtinicio: diasAtras(entre(30, 120)),
    dtfim: null,
  }));

  const estoque: Row[] = PRODUTOS.map((_p, i) => ({
    codprod: 1001 + i,
    qtestger: entre(0, 800),
    qtreserv: entre(0, 40),
    dtultent: diasAtras(entre(1, 30)),
  }));

  const pedidos: Row[] = [];
  const itens: Row[] = [];
  const titulos: Row[] = [];
  let numtit = 1;

  for (let numped = 90_001; numped <= 90_500; numped++) {
    const codcli = entre(1, NOMES_CLIENTE.length);
    const idadeDias = entre(0, 90);
    // pedidos recentes ainda fluem; antigos quase todos entregues
    const posicao =
      idadeDias <= 2
        ? escolher(['P', 'S', 'F'] as const)
        : idadeDias <= 7
          ? escolher(['F', 'S', 'T', 'E'] as const)
          : rng() < 0.04
            ? 'C'
            : 'E';

    const nItens = entre(1, 8);
    const usados = new Set<number>();
    let vltotal = 0;
    for (let seq = 1; seq <= nItens; seq++) {
      let idx = entre(0, PRODUTOS.length - 1);
      while (usados.has(idx)) idx = (idx + 1) % PRODUTOS.length;
      usados.add(idx);
      const qt = entre(1, 20);
      const punit = (PRODUTOS[idx] as ProdutoSeed).preco;
      const sub = Math.round(qt * punit * 100) / 100;
      vltotal = Math.round((vltotal + sub) * 100) / 100;
      itens.push({
        numped,
        numseq: seq,
        codprod: 1001 + idx,
        qt,
        punit,
        vlsubtotal: sub,
      });
    }

    pedidos.push({ numped, codcli, dtemis: diasAtras(idadeDias), posicao, vltotal });

    // títulos coerentes: pedidos faturados+ geram 1-3 parcelas somando o total
    if (posicao === 'F' || posicao === 'T' || posicao === 'E') {
      const parcelas = entre(1, 3);
      const valorParcela = Math.round((vltotal / parcelas) * 100) / 100;
      for (let p = 1; p <= parcelas; p++) {
        const valor =
          p === parcelas
            ? Math.round((vltotal - valorParcela * (parcelas - 1)) * 100) / 100
            : valorParcela;
        const vencEmDias = idadeDias - 28 * p; // >0 = já venceu; <0 = vence no futuro
        const pago = vencEmDias > 5 ? rng() < 0.8 : vencEmDias > 0 ? rng() < 0.3 : false;
        titulos.push({
          numtit: numtit++,
          prest: String(p).padStart(2, '0'),
          codcli,
          numped,
          valor,
          dtvenc: diasAtras(vencEmDias),
          dtpago: pago ? diasAtras(Math.max(0, vencEmDias - entre(-3, 5))) : null,
          codcob: 'BOL',
          linhadig: Array.from({ length: 47 }, () => entre(0, 9)).join(''),
        });
      }
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'TRUNCATE pctabpreco, pcest, pcprest, pcpediitem, pcpedido, pcprodut, pcclient',
    );
    await inserirLote(
      client,
      'pcclient',
      ['codcli', 'cgcent', 'cliente', 'fantasia', 'dtcad', 'bloqueio'],
      clientes,
    );
    await inserirLote(
      client,
      'pcprodut',
      ['codprod', 'descricao', 'embalagem', 'unidade', 'codauxiliar'],
      produtos,
    );
    await inserirLote(
      client,
      'pcpedido',
      ['numped', 'codcli', 'dtemis', 'posicao', 'vltotal'],
      pedidos,
    );
    await inserirLote(
      client,
      'pcpediitem',
      ['numped', 'numseq', 'codprod', 'qt', 'punit', 'vlsubtotal'],
      itens,
    );
    await inserirLote(
      client,
      'pcprest',
      ['numtit', 'prest', 'codcli', 'numped', 'valor', 'dtvenc', 'dtpago', 'codcob', 'linhadig'],
      titulos,
    );
    await inserirLote(client, 'pcest', ['codprod', 'qtestger', 'qtreserv', 'dtultent'], estoque);
    await inserirLote(
      client,
      'pctabpreco',
      ['numregiao', 'codprod', 'pvenda', 'dtinicio', 'dtfim'],
      precos,
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  return {
    clientes: clientes.length,
    produtos: produtos.length,
    pedidos: pedidos.length,
    itens: itens.length,
    titulos: titulos.length,
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
