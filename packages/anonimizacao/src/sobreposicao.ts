import type { Deteccao, TipoPii } from './tipos.js';

/**
 * Resolve spans sobrepostos: o mais longo vence; em empate de tamanho, o tipo
 * mais específico (CPF antes de telefone — um número de 11 dígitos com DV de
 * CPF é CPF); em empate total, o que começa antes. Determinístico.
 */

const PRIORIDADE: Readonly<Record<TipoPii, number>> = {
  cpf: 0,
  cnpj: 1,
  cartao: 2,
  email: 3,
  telefone: 4,
  cep: 5,
  placa: 6,
  nome: 7,
};

export function resolverSobreposicao(achados: readonly Deteccao[]): Deteccao[] {
  const ordenados = [...achados].sort((a, b) => {
    const la = a.fim - a.inicio;
    const lb = b.fim - b.inicio;
    if (la !== lb) return lb - la;
    if (PRIORIDADE[a.tipo] !== PRIORIDADE[b.tipo]) return PRIORIDADE[a.tipo] - PRIORIDADE[b.tipo];
    return a.inicio - b.inicio;
  });
  const aceitos: Deteccao[] = [];
  for (const d of ordenados) {
    if (d.fim <= d.inicio) continue;
    const colide = aceitos.some((a) => d.inicio < a.fim && a.inicio < d.fim);
    if (!colide) aceitos.push(d);
  }
  return aceitos.sort((a, b) => a.inicio - b.inicio);
}
