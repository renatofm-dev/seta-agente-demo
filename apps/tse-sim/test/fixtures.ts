import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Leitura do contrato extraído da coleção do fornecedor (`pnpm tse:fixtures`). */

const CONTRATO = join(import.meta.dirname, '../contrato');

export interface EntradaIndice {
  readonly nome: string;
  readonly pasta: string;
  readonly method: string;
  readonly path: string;
  readonly pathParams: readonly string[];
  readonly query: readonly string[];
  readonly status: number;
  readonly contentType: string;
  readonly arquivo: string;
}

export interface Fixture extends EntradaIndice {
  readonly requestBody: unknown;
  readonly body?: unknown;
  readonly bodySha256?: string;
  readonly bodyBytes?: number;
}

export function lerIndice(): EntradaIndice[] {
  return JSON.parse(readFileSync(join(CONTRATO, 'indice.json'), 'utf-8')) as EntradaIndice[];
}

export function lerFixture(nome: string): Fixture {
  return JSON.parse(readFileSync(join(CONTRATO, 'fixtures', `${nome}.json`), 'utf-8')) as Fixture;
}

export function lerColecaoSha(): string {
  return readFileSync(join(CONTRATO, 'tse-api.collection.sha256'), 'utf-8')
    .trim()
    .split(/\s+/)[0] as string;
}
