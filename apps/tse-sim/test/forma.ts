/**
 * FORMA de uma resposta: conjunto de chaves, tipo de cada folha e formato de
 * data. É o que dá para exigir de um dublê sem ambiente do fornecedor — o
 * exemplo salvo tem UM valor, e valor não é contrato.
 */

export type Forma = string | Forma[] | { [k: string]: Forma };

const DATA_TSE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?[+-]\d{2}:\d{2}$/;

export function forma(valor: unknown): Forma {
  if (valor === null || valor === undefined) return 'nulo';
  if (Array.isArray(valor)) return valor.length === 0 ? [] : [forma(valor[0])];
  if (typeof valor === 'object') {
    const saida: Record<string, Forma> = {};
    for (const chave of Object.keys(valor).sort()) {
      saida[chave] = forma((valor as Record<string, unknown>)[chave]);
    }
    return saida;
  }
  if (typeof valor === 'string') return DATA_TSE.test(valor) ? 'data' : 'texto';
  return typeof valor;
}

/**
 * Compara duas formas e devolve as divergências em linguagem de gente.
 *
 * Duas tolerâncias, ambas por causa do tamanho da amostra (um exemplo por rota):
 * `nulo` de qualquer lado casa com tudo (o campo é anulável e o exemplo pegou
 * um dos dois casos), e lista vazia não diz nada sobre o elemento.
 */
export function conferirForma(
  esperado: Forma,
  obtido: Forma,
  caminho = 'raiz',
  erros: string[] = [],
): string[] {
  if (esperado === 'nulo' || obtido === 'nulo') return erros;
  if (Array.isArray(esperado) && Array.isArray(obtido)) {
    const [e] = esperado;
    const [o] = obtido;
    if (e !== undefined && o !== undefined) conferirForma(e, o, `${caminho}[]`, erros);
    return erros;
  }
  if (typeof esperado === 'object' && typeof obtido === 'object') {
    const chavesE = Object.keys(esperado);
    const chavesO = Object.keys(obtido);
    const faltando = chavesE.filter((k) => !chavesO.includes(k));
    const inventadas = chavesO.filter((k) => !chavesE.includes(k));
    if (faltando.length > 0)
      erros.push(`${caminho}: o simulador não devolve ${faltando.join(', ')}`);
    if (inventadas.length > 0) {
      erros.push(`${caminho}: o simulador inventou ${inventadas.join(', ')}`);
    }
    for (const chave of chavesE.filter((k) => chavesO.includes(k))) {
      conferirForma(
        (esperado as Record<string, Forma>)[chave] as Forma,
        (obtido as Record<string, Forma>)[chave] as Forma,
        `${caminho}.${chave}`,
        erros,
      );
    }
    return erros;
  }
  if (esperado !== obtido) {
    erros.push(
      `${caminho}: o TSE devolve ${String(esperado)}, o simulador devolve ${String(obtido)}`,
    );
  }
  return erros;
}
