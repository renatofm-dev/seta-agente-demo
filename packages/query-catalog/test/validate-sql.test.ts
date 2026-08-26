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

const CLIENTE_ID = { cliente_id: { type: 'string', source: 'session' } };

describe('validador estático de SQL', () => {
  it('aceita SELECT canônico com binds corretos', () => {
    expect(
      validateEntrySql(
        entrada('SELECT id FROM v_pedido WHERE cliente_id = :cliente_id', CLIENTE_ID),
      ),
    ).toEqual([]);
  });

  it('reprova DDL e DML', () => {
    expect(validateEntrySql(entrada('DROP TABLE pcclient')).join(' ')).toMatch(/proibido/);
    expect(
      validateEntrySql(
        entrada("UPDATE v_pedido SET status = 'x' WHERE cliente_id = :cliente_id", CLIENTE_ID),
      ).join(' '),
    ).toMatch(/update.*proibido|proibid/i);
  });

  it('reprova mais de um statement', () => {
    expect(
      validateEntrySql(entrada('SELECT 1 FROM v_cliente; SELECT 2 FROM v_cliente')).join(' '),
    ).toMatch(/mais de um statement/);
  });

  it('reprova objeto fora da allowlist (tabela física)', () => {
    expect(
      validateEntrySql(
        entrada('SELECT codcli FROM pcclient WHERE codcli = :cliente_id', CLIENTE_ID),
      ).join(' '),
    ).toMatch(/fora da allowlist/);
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: o caso testado é exatamente esse
  it('reprova interpolação ${} e placeholder cru', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: o caso testado é exatamente esse
    expect(validateEntrySql(entrada('SELECT id FROM v_pedido WHERE id = ${id}')).join(' ')).toMatch(
      /interpolação/,
    );
    expect(validateEntrySql(entrada('SELECT id FROM v_pedido WHERE id = $1')).join(' ')).toMatch(
      /placeholder posicional/,
    );
  });

  it('reprova bind sem param e param sem bind', () => {
    expect(
      validateEntrySql(entrada('SELECT id FROM v_pedido WHERE id = :orfao')).join(' '),
    ).toMatch(/bind :orfao sem param/);
    expect(
      validateEntrySql(
        entrada('SELECT id FROM v_pedido', {
          sobrando: { type: 'string', source: 'agent' },
        }),
      ).join(' '),
    ).toMatch(/param "sobrando" declarado sem bind/);
  });

  it('reprova param de sessão que o executor não sabe resolver', () => {
    expect(
      validateEntrySql(
        entrada('SELECT id FROM v_pedido WHERE id = :misterio', {
          misterio: { type: 'string', source: 'session' },
        }),
      ).join(' '),
    ).toMatch(/param de sessão desconhecido/);
  });
});
