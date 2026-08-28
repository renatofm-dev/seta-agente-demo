/**
 * Reciprocal Rank Fusion: score(d) = Σ_listas 1/(c + rank_d). Combina rankings
 * denso e lexical sem calibrar escalas de score entre si.
 */
export function fuseRrf<T extends { readonly id: string }>(
  listas: readonly (readonly T[])[],
  k: number,
  c = 60,
): Array<T & { readonly score: number }> {
  const scores = new Map<string, { item: T; score: number }>();
  for (const lista of listas) {
    lista.forEach((item, rank) => {
      const atual = scores.get(item.id);
      const incremento = 1 / (c + rank + 1);
      if (atual) atual.score += incremento;
      else scores.set(item.id, { item, score: incremento });
    });
  }
  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(({ item, score }) => ({ ...item, score }));
}
