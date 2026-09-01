import { createPgConnector, type DbConnector, QueryTimeoutError } from '@seta/erp-connector';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminUrl,
  applySchema,
  CONTRATO_DEMO_INADIMPLENTE,
  seedData,
} from '../../../infra/erp-mock/seed.ts';

/**
 * Testes de integração das specs 002/012 — exigem o Postgres dev de pé
 * (docker compose -f infra/compose.dev.yml up -d). Critérios: timeout,
 * maxRows/truncated, permissões do erp_ro (inclusive LGPD em pessoa/contrato),
 * idempotência do seed e regras de negócio das views canônicas.
 */

const ERP_RO_URL =
  process.env.ERP_DATABASE_URL ?? 'postgres://erp_ro:erp_ro_dev@localhost:5432/erp_mock';

let admin: pg.Pool;
let connector: DbConnector;

beforeAll(async () => {
  admin = new pg.Pool({ connectionString: adminUrl(), max: 2 });
  try {
    await admin.query('SELECT 1');
  } catch (err) {
    throw new Error(
      'Postgres dev indisponível — suba com: docker compose -f infra/compose.dev.yml up -d --wait',
      { cause: err },
    );
  }
  await applySchema(admin);
  await seedData(admin); // banco pode nascer limpo (CI) — testes não dependem de seed externo
  connector = createPgConnector({ url: ERP_RO_URL, poolMax: 3 });
}, 60_000);

afterAll(async () => {
  await connector?.close();
  await admin?.end();
});

describe('erp-connector pg (integração)', () => {
  it('execute respeita timeoutMs via statement_timeout (pg_sleep)', async () => {
    await expect(
      connector.execute(
        { sql: 'SELECT pg_sleep(:segundos)', binds: { segundos: 2 } },
        { timeoutMs: 150 },
      ),
    ).rejects.toThrow(QueryTimeoutError);
  });

  it('execute corta em maxRows e sinaliza truncated', async () => {
    const cortado = await connector.execute(
      { sql: 'SELECT g AS n FROM generate_series(1, :total) g', binds: { total: 100 } },
      { maxRows: 10 },
    );
    expect(cortado.rows).toHaveLength(10);
    expect(cortado.rowCount).toBe(10);
    expect(cortado.truncated).toBe(true);

    const completo = await connector.execute(
      { sql: 'SELECT g AS n FROM generate_series(1, :total) g', binds: { total: 5 } },
      { maxRows: 10 },
    );
    expect(completo.rows).toHaveLength(5);
    expect(completo.truncated).toBe(false);
    expect(completo.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('health responde ok com latência', async () => {
    const h = await connector.health();
    expect(h.ok).toBe(true);
    expect(h.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

describe('fronteira erp_ro (integração)', () => {
  it('lê as 6 views canônicas', async () => {
    for (const view of [
      'v_cotista',
      'v_contrato_cota',
      'v_titulo',
      'v_inadimplencia',
      'v_cancelamento',
      'v_chamado',
    ]) {
      // nome vem de lista fixa do teste, não de input externo
      const r = await connector.execute({ sql: `SELECT * FROM ${view}`, binds: {} }, {});
      expect(r.rows.length, view).toBeGreaterThan(0);
    }
  });

  it('NÃO lê tabela física — nem pessoa/contrato (LGPD)', async () => {
    for (const tabela of ['pessoa', 'contrato', 'contafinanceira', 'cotauh']) {
      await expect(
        connector.execute({ sql: `SELECT * FROM ${tabela}`, binds: {} }, {}),
      ).rejects.toThrow(/permission denied/);
    }
  });

  it('NÃO escreve em nada — nem via cliente pg direto', async () => {
    const cliente = new pg.Client({ connectionString: ERP_RO_URL });
    await cliente.connect();
    try {
      await expect(
        cliente.query(
          "INSERT INTO pessoa (idpessoa, nome, cpf) VALUES (999999, 'x', '000.000.000-00')",
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(cliente.query('DELETE FROM contafinanceira')).rejects.toThrow(
        /permission denied/,
      );
      await expect(
        cliente.query("UPDATE contrato SET statuscontrato = 'CANCELADO'"),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await cliente.end();
    }
  });
});

describe('seed erp_mock (integração)', () => {
  it('rodar 2x não duplica (contagens estáveis)', async () => {
    const resumo1 = await seedData(admin);
    const resumo2 = await seedData(admin);
    // volumes fixos são estáveis; os aleatórios (títulos) conferem com a tabela
    expect(resumo1.cotas).toBe(400);
    expect(resumo1.contratos).toBe(120);
    expect(resumo2.contratos).toBe(120);

    const contar = async (tabela: string) => {
      // tabela vem de lista fixa do teste, não de input externo
      const r = await admin.query(`SELECT count(*)::int AS n FROM ${tabela}`);
      return (r.rows[0] as { n: number }).n;
    };
    expect(await contar('cotauh')).toBe(resumo2.cotas);
    expect(await contar('contrato')).toBe(resumo2.contratos);
    expect(await contar('contafinanceira')).toBe(resumo2.titulos);
    expect(await contar('cancelamento')).toBe(resumo2.cancelamentos);
    expect(await contar('ocorrenciaatendimentots')).toBe(resumo2.chamados);
  }, 60_000);

  it('proporções do espelho: cotas por status e contratos cancelados majoritários', async () => {
    const cotas = await admin.query(
      'SELECT statuscota, count(*)::int AS n FROM cotauh GROUP BY statuscota',
    );
    const porStatus = Object.fromEntries(
      cotas.rows.map((r: { statuscota: string; n: number }) => [r.statuscota, r.n]),
    ) as Record<string, number>;
    expect(porStatus.BLOQUEIOADMINISTRATIVO).toBe(228);
    expect(porStatus.VENDIDA).toBe(128);
    expect(porStatus.DISPONIVEL).toBe(44);

    const contratos = await admin.query(
      "SELECT count(*)::int AS n FROM contrato WHERE statuscontrato = 'CANCELADO'",
    );
    expect((contratos.rows[0] as { n: number }).n).toBeGreaterThan(50);
  });
});

describe('regras de negócio das views (spec 012)', () => {
  it('v_cotista NUNCA devolve nome ou CPF reais — só o pseudônimo', async () => {
    const r = await connector.execute(
      { sql: 'SELECT titular, numero_contrato FROM v_cotista', binds: {} },
      { maxRows: 500 },
    );
    expect(r.rows.length).toBeGreaterThan(0);
    for (const row of r.rows as { titular: string; numero_contrato: string }[]) {
      expect(row.titular).toBe(`Titular do contrato ${row.numero_contrato}`);
    }
    // nenhum nome/CPF da tabela física vaza para a view
    const nomes = await admin.query('SELECT nome, cpf FROM pessoa');
    const titulares = new Set(r.rows.map((x) => (x as { titular: string }).titular));
    for (const p of nomes.rows as { nome: string; cpf: string }[]) {
      expect(titulares.has(p.nome)).toBe(false);
    }
    // e a view nem tem coluna de documento
    const colunas = await admin.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'v_cotista'",
    );
    const nomesColunas = colunas.rows.map((c: { column_name: string }) => c.column_name);
    expect(nomesColunas).not.toContain('cpf');
    expect(nomesColunas).not.toContain('nome');
  });

  it('contrato ativo = ATIVO + ATIVOREV (contar só ATIVO perderia contratos)', async () => {
    const fisica = await admin.query(
      "SELECT count(*)::int AS n FROM contrato WHERE statuscontrato IN ('ATIVO', 'ATIVOREV')",
    );
    const soAtivo = await admin.query(
      "SELECT count(*)::int AS n FROM contrato WHERE statuscontrato = 'ATIVO'",
    );
    const view = await connector.execute(
      { sql: "SELECT count(*)::int AS n FROM v_cotista WHERE status = 'ativo'", binds: {} },
      {},
    );
    const nFisica = (fisica.rows[0] as { n: number }).n;
    expect((view.rows[0] as { n: number }).n).toBe(nFisica);
    expect((soAtivo.rows[0] as { n: number }).n).toBeLessThan(nFisica); // ATIVOREV existe no seed
  });

  it('v_titulo descarta vencimento fora da janela de sanidade (linhas semeadas em ano absurdo)', async () => {
    // as 2 linhas de prova têm numeroparcela 998/999 no contrato demo inadimplente
    const fisica = await admin.query({
      text: `SELECT count(*)::int AS n FROM contafinanceira
             WHERE idcontrato = $1 AND numeroparcela IN (998, 999) AND tipohistorico = 'ATIVO'`,
      values: [CONTRATO_DEMO_INADIMPLENTE],
    });
    expect((fisica.rows[0] as { n: number }).n).toBe(2);
    const view = await connector.execute(
      {
        sql: 'SELECT count(*)::int AS n FROM v_titulo WHERE contrato_id = :contrato AND parcela IN (998, 999)',
        binds: { contrato: String(CONTRATO_DEMO_INADIMPLENTE) },
      },
      {},
    );
    expect((view.rows[0] as { n: number }).n).toBe(0);
  });

  it('v_titulo usa datavencimentorecorrencia, não o datavencimento reescrito', async () => {
    // linha de prova: recorrente NÃO paga, datavencimento reescrito p/ o futuro,
    // recorrência vencida há 40 dias ⇒ a view TEM de dizer "vencido"
    const r = await connector.execute(
      {
        sql: 'SELECT status, vencimento FROM v_titulo WHERE contrato_id = :contrato AND parcela = :parcela',
        binds: { contrato: String(CONTRATO_DEMO_INADIMPLENTE), parcela: 997 },
      },
      {},
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.status).toBe('vencido');
    expect(new Date(r.rows[0]?.vencimento as string).getTime()).toBeLessThan(Date.now());
  });

  it('v_titulo só expõe histórico ATIVO', async () => {
    const canceladas = await admin.query(
      "SELECT count(*)::int AS n FROM contafinanceira WHERE tipohistorico <> 'ATIVO'",
    );
    expect((canceladas.rows[0] as { n: number }).n).toBeGreaterThan(0); // o seed gera
    const total = await connector.execute(
      { sql: 'SELECT count(*)::int AS n FROM v_titulo', binds: {} },
      {},
    );
    const ativosNaJanela = await admin.query(
      `SELECT count(*)::int AS n FROM contafinanceira
       WHERE tipohistorico = 'ATIVO'
         AND coalesce(datavencimentorecorrencia, datavencimento)
             BETWEEN DATE '2020-01-01' AND current_date + interval '30 years'`,
    );
    expect((total.rows[0] as { n: number }).n).toBe((ativosNaJanela.rows[0] as { n: number }).n);
  });

  it('v_inadimplencia agrega os vencidos do contrato demo inadimplente', async () => {
    const r = await connector.execute(
      {
        sql: 'SELECT * FROM v_inadimplencia WHERE contrato_id = :contrato',
        binds: { contrato: String(CONTRATO_DEMO_INADIMPLENTE) },
      },
      {},
    );
    expect(r.rows).toHaveLength(1);
    const linha = r.rows[0] as {
      qtd_titulos_vencidos: number;
      saldo_vencido_centavos: string;
      maior_atraso_dias: number;
    };
    expect(linha.qtd_titulos_vencidos).toBeGreaterThanOrEqual(3);
    expect(Number(linha.saldo_vencido_centavos)).toBeGreaterThan(0);
    expect(linha.maior_atraso_dias).toBeGreaterThan(0);
  });

  it('v_cancelamento traz SÓ o último distrato por contrato (DISTINCT ON)', async () => {
    const duplicados = await connector.execute(
      {
        sql: 'SELECT contrato_id, count(*)::int AS n FROM v_cancelamento GROUP BY contrato_id HAVING count(*) > :um',
        binds: { um: 1 },
      },
      {},
    );
    expect(duplicados.rows).toHaveLength(0);
    // o contrato demo tem pedido antigo NEGADO + atual EMANALISE ⇒ vence o atual
    const demo = await connector.execute(
      {
        sql: 'SELECT status, multa_centavos, reembolso_centavos FROM v_cancelamento WHERE contrato_id = :contrato',
        binds: { contrato: '10003' },
      },
      {},
    );
    expect(demo.rows[0]?.status).toBe('em_analise');
    expect(Number(demo.rows[0]?.multa_centavos)).toBe(850_000);
    expect(Number(demo.rows[0]?.reembolso_centavos)).toBe(1_275_000);
  });

  it('v_contrato_cota resolve o fallback idcotaativa → idcotaadquirida (contrato demo)', async () => {
    // o 10001 tem idcotaativa NULL de propósito — a view cai na adquirida
    const r = await connector.execute(
      {
        sql: 'SELECT bloco, tier, periodos, pontos FROM v_contrato_cota WHERE contrato_id = :contrato',
        binds: { contrato: '10001' },
      },
      {},
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.bloco).toBe('TORRE 2');
    expect(r.rows[0]?.tier).toBe('DIAMANTE PREMIUM');
    expect(r.rows[0]?.periodos).toBe(2);
  });

  it('v_chamado expõe as ocorrências do titular por contrato', async () => {
    const r = await connector.execute(
      {
        sql: 'SELECT status, motivo FROM v_chamado WHERE contrato_id = :contrato',
        binds: { contrato: String(CONTRATO_DEMO_INADIMPLENTE) },
      },
      {},
    );
    expect(r.rows.length).toBeGreaterThanOrEqual(1);
    const abertos = r.rows.filter((x) => x.status === 'aberto');
    expect(abertos.some((x) => x.motivo === 'SEGUNDA VIA DE BOLETO')).toBe(true);
  });
});
