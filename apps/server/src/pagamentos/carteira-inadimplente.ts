import type { DbConnector } from '@seta/erp-connector';
import { inArray } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { contato } from '../db/schema.js';

/**
 * 044 — quem cobrar: a carteira inadimplente.
 *
 * ## Por que isto NÃO é uma entrada de catálogo
 *
 * O `query-catalog` existe para o AGENTE ler dado do cotista que está
 * conversando: todo param é `source: session` (o `contrato_id` vem do vínculo,
 * nunca do modelo) ou `source: agent`. Não há terceira origem, e inventar uma
 * "operador" mexeria justamente no bind que impede o LLM de escolher de qual
 * contrato ele lê — o controle de acesso do produto.
 *
 * Aqui a pergunta é outra: *quem*, na carteira inteira, está em atraso. Não tem
 * sessão, não tem cotista, e quem pergunta é o operador no console. Então ela
 * mora no servidor, com bind nomeado como qualquer SQL desta base.
 *
 * (A `financeiro.titulos_atraso` do catálogo NÃO serve: ela responde "o que
 * está vencido NESTE contrato". Foi a primeira coisa que eu tentei usar.)
 *
 * ## Por que são duas etapas, e não um JOIN
 *
 * A inadimplência vive no banco do **ERP** (`v_inadimplencia`, `v_titulo`) e a
 * carteira vive no banco do **app** (`contato.cliente_erp_id`). São conexões
 * diferentes, com credenciais diferentes — o `erp_ro` é só-leitura e nem
 * enxerga o schema do produto. Não existe `JOIN` possível: pergunta-se ao ERP
 * quem deve, e cruza-se com a carteira aqui.
 *
 * A ordem importa: o ERP primeiro. Perguntar "estes 4 contatos estão em
 * atraso?" funciona com 4 e não com 4 mil; perguntar "quem está em atraso" e
 * filtrar pela carteira funciona nos dois tamanhos.
 */

export interface AlvoCobranca {
  readonly waId: string;
  readonly nome: string | null;
  readonly contratoId: string;
  readonly qtdVencidas: number;
  readonly saldoVencidoCentavos: number;
  readonly maiorAtrasoDias: number;
  /** A parcela mais antiga em aberto — é ela que a campanha cobra. */
  readonly parcela: number;
  readonly parcelaTituloId: string;
  readonly parcelaValorCentavos: number;
  readonly parcelaVencimento: string;
}

export interface FiltroCarteira {
  /** Atraso mínimo em dias (0 = qualquer vencida). */
  readonly atrasoMinimoDias: number;
  /** Saldo vencido mínimo em centavos. */
  readonly saldoMinimoCentavos: number;
}

export const FILTRO_PADRAO: FiltroCarteira = { atrasoMinimoDias: 1, saldoMinimoCentavos: 0 };

/**
 * Uma linha por contrato inadimplente, já com a parcela mais antiga em aberto.
 *
 * `DISTINCT ON` em vez de subquery correlacionada: uma varredura, e o
 * `ORDER BY` dentro dele é o que define "mais antiga". A cobrança é de UMA
 * parcela por destinatário de propósito — cobrar todas as vencidas de uma vez
 * joga o valor acima do teto de alçada e a campanha inteira para a fila de
 * aprovação humana, o que a tornaria inútil como campanha.
 */
const SQL_INADIMPLENTES = `
  SELECT DISTINCT ON (t.contrato_id)
         t.contrato_id,
         t.id            AS titulo_id,
         t.parcela,
         t.valor_centavos,
         t.vencimento,
         i.qtd_titulos_vencidos,
         i.saldo_vencido_centavos,
         i.maior_atraso_dias
    FROM v_titulo t
    JOIN v_inadimplencia i ON i.contrato_id = t.contrato_id
   WHERE t.status = 'vencido'
     AND i.maior_atraso_dias >= :atraso_minimo
     AND i.saldo_vencido_centavos >= :saldo_minimo
   ORDER BY t.contrato_id, t.vencimento ASC
`;

interface LinhaErp {
  contrato_id: string;
  titulo_id: string;
  parcela: number;
  valor_centavos: string | number;
  vencimento: unknown;
  qtd_titulos_vencidos: number;
  saldo_vencido_centavos: string | number;
  maior_atraso_dias: number;
}

const inteiro = (v: string | number): number => (typeof v === 'number' ? v : Number(v));

/**
 * `YYYY-MM-DD`, sempre.
 *
 * A coluna `vencimento` é `date` e o driver do pg a devolve como `Date` — um
 * `String()` nela dá "Mon Jul 27 2026 00:00:00 GMT-0300", que é o que o cotista
 * leria na mensagem de cobrança. `toISOString` em `Date` de data pura é seguro
 * aqui porque o pg constrói a meia-noite LOCAL e a fatia é feita sobre UTC —
 * então a conversão é explícita em vez de acidental.
 */
function dataIso(v: unknown): string {
  if (v instanceof Date) {
    const ano = v.getFullYear();
    const mes = String(v.getMonth() + 1).padStart(2, '0');
    const dia = String(v.getDate()).padStart(2, '0');
    return `${ano}-${mes}-${dia}`;
  }
  return String(v).slice(0, 10);
}

export async function carteiraInadimplente(
  deps: { readonly db: Db; readonly erp: DbConnector },
  filtro: FiltroCarteira = FILTRO_PADRAO,
): Promise<AlvoCobranca[]> {
  const r = await deps.erp.execute(
    {
      sql: SQL_INADIMPLENTES,
      binds: { atraso_minimo: filtro.atrasoMinimoDias, saldo_minimo: filtro.saldoMinimoCentavos },
    },
    { timeoutMs: 5_000, maxRows: 2_000 },
  );
  const porContrato = new Map<string, LinhaErp>();
  for (const linha of r.rows as unknown as LinhaErp[]) {
    porContrato.set(String(linha.contrato_id), linha);
  }
  if (porContrato.size === 0) return [];

  // cruza com a carteira: contrato inadimplente sem contato não é alvo — não há
  // para onde mandar, e inventar destinatário é pior que não cobrar
  const contatos = await deps.db
    .select({ waId: contato.waId, nome: contato.nome, clienteErpId: contato.clienteErpId })
    .from(contato)
    .where(inArray(contato.clienteErpId, [...porContrato.keys()]));

  return contatos
    .map((c) => {
      const l = porContrato.get(c.clienteErpId);
      if (!l) return null;
      return {
        waId: c.waId,
        nome: c.nome,
        contratoId: c.clienteErpId,
        qtdVencidas: inteiro(l.qtd_titulos_vencidos),
        saldoVencidoCentavos: inteiro(l.saldo_vencido_centavos),
        maiorAtrasoDias: inteiro(l.maior_atraso_dias),
        parcela: inteiro(l.parcela),
        parcelaTituloId: String(l.titulo_id),
        parcelaValorCentavos: inteiro(l.valor_centavos),
        parcelaVencimento: dataIso(l.vencimento),
      } satisfies AlvoCobranca;
    })
    .filter((a): a is AlvoCobranca => a !== null)
    .sort((a, b) => b.maiorAtrasoDias - a.maiorAtrasoDias);
}
