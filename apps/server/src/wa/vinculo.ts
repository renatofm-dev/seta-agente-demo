import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';

/**
 * Vínculo contato↔cliente da demo, lido de configs/demo/contatos.yaml.
 * PROVISÓRIO da 005: a spec 007 grava esses vínculos em tabela no banco `app`
 * (corte da 000: verificação de vínculo fica pré-vinculada por seed).
 */

const ContatosSchema = z.object({
  contatos: z.array(
    z.object({
      wa_id: z.string().regex(/^[1-9]\d{7,14}$/),
      cliente_erp: z.string().min(1),
      apelido: z.string().optional(),
    }),
  ),
});

export type Vinculos = ReadonlyMap<string, string>;

export function loadVinculos(path: string): Vinculos {
  const parsed = ContatosSchema.parse(parse(readFileSync(path, 'utf-8')));
  return new Map(parsed.contatos.map((c) => [c.wa_id, c.cliente_erp]));
}
