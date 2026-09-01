import { type CatalogEntry, CatalogEntrySchema, validateEntrySql } from '@seta/query-catalog';
import { describe, expect, it } from 'vitest';

function entrada(sql: string, params: Record<string, unknown> = {}): CatalogEntry {
  return CatalogEntrySchema.parse({
    id: 'teste.entrada',
    version: 1,
    description: 'Entrada de teste do validador estático de SQL do catálogo.',
    entities: ['teste'],
    params,
    sql,
    output: { columns: ['id'] },
    tool: { expose: false, name: 'teste' },
  });
}

const CONTRATO_ID = { contrato_id: { type: 'string', source: 'session' } };

describe('validador estático de SQL', () => {
  it('aceita SELECT canônico com binds corretos', () => {
    expect(
      validateEntrySql(
        entrada('SELECT id FROM v_titulo WHERE contrato_id = :contrato_id', CONTRATO_ID),
      ),
    ).toEqual([]);
  });

  it('aceita JOIN entre views canônicas (titulos_atraso junta título + inadimplência)', () => {
    expect(
      validateEntrySql(
        entrada(
          'SELECT t.id FROM v_titulo t JOIN v_inadimplencia i ON i.contrato_id = t.contrato_id WHERE t.contrato_id = :contrato_id',
          CONTRATO_ID,
        ),
      ),
    ).toEqual([]);
  });

  it('reprova DDL e DML', () => {
    expect(validateEntrySql(entrada('DROP TABLE pessoa')).join(' ')).toMatch(/proibido/);
    expect(
      validateEntrySql(
        entrada("UPDATE v_titulo SET status = 'x' WHERE contrato_id = :contrato_id", CONTRATO_ID),
      ).join(' '),
    ).toMatch(/update.*proibido|proibid/i);
  });

  it('reprova mais de um statement', () => {
    expect(
      validateEntrySql(entrada('SELECT 1 FROM v_cotista; SELECT 2 FROM v_cotista')).join(' '),
    ).toMatch(/mais de um statement/);
  });

  it('reprova objeto fora da allowlist (tabela física com dado pessoal)', () => {
    expect(
      validateEntrySql(
        entrada('SELECT nome, cpf FROM pessoa WHERE idpessoa = :contrato_id', CONTRATO_ID),
      ).join(' '),
    ).toMatch(/fora da allowlist/);
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: o caso testado é exatamente esse
  it('reprova interpolação ${} e placeholder cru', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: o caso testado é exatamente esse
    expect(validateEntrySql(entrada('SELECT id FROM v_titulo WHERE id = ${id}')).join(' ')).toMatch(
      /interpolação/,
    );
    expect(validateEntrySql(entrada('SELECT id FROM v_titulo WHERE id = $1')).join(' ')).toMatch(
      /placeholder posicional/,
    );
  });

  it('reprova bind sem param e param sem bind', () => {
    expect(
      validateEntrySql(entrada('SELECT id FROM v_titulo WHERE id = :orfao')).join(' '),
    ).toMatch(/bind :orfao sem param/);
    expect(
      validateEntrySql(
        entrada('SELECT id FROM v_titulo', {
          sobrando: { type: 'string', source: 'agent' },
        }),
      ).join(' '),
    ).toMatch(/param "sobrando" declarado sem bind/);
  });

  it('reprova param de sessão que o executor não sabe resolver', () => {
    expect(
      validateEntrySql(
        entrada('SELECT id FROM v_titulo WHERE id = :misterio', {
          misterio: { type: 'string', source: 'session' },
        }),
      ).join(' '),
    ).toMatch(/param de sessão desconhecido/);
    // pessoa_id não tem fonte na sessão da POC (o vínculo carrega só o contrato)
    expect(
      validateEntrySql(
        entrada('SELECT id FROM v_chamado WHERE contrato_id = :pessoa_id', {
          pessoa_id: { type: 'string', source: 'session' },
        }),
      ).join(' '),
    ).toMatch(/param de sessão desconhecido/);
  });
});
