import { type Contagem, type Deteccao, ROTULO_POR_TIPO, TIPOS_PII, type TipoPii } from './tipos.js';

/**
 * Cofre de UMA chamada: valor ↔ token. Mesmo valor (normalizado) ⇒ mesmo
 * token; numeração por ordem de aparição. Vive só na memória, só durante a
 * chamada — nunca é persistido.
 */

const ROTULOS = Object.values(ROTULO_POR_TIPO).join('|');
/** Tolerante ao que a LLM faz com o token: caixa, espaço, colchete perdido. */
const RE_TOKEN = new RegExp(`\\[\\s*(${ROTULOS})_(\\d+)\\s*\\]`, 'gi');

function normalizar(tipo: TipoPii, valor: string): string {
  switch (tipo) {
    case 'nome':
      return valor.trim().toLowerCase().replaceAll(/\s+/g, ' ');
    case 'email':
      return valor.trim().toLowerCase();
    case 'placa':
      return valor.toUpperCase().replaceAll(/[^A-Z0-9]/g, '');
    default:
      return valor.replaceAll(/\D/g, '');
  }
}

export class Cofre {
  private readonly porChave = new Map<string, string>();
  private readonly porToken = new Map<string, string>();
  private readonly contadores: Record<TipoPii, number> = Object.fromEntries(
    TIPOS_PII.map((t) => [t, 0]),
  ) as Record<TipoPii, number>;

  /** Token estável para a detecção (cria na primeira vez). */
  token(d: Deteccao): string {
    const chave = `${d.tipo}:${normalizar(d.tipo, d.valor)}`;
    const existente = this.porChave.get(chave);
    if (existente) return existente;
    this.contadores[d.tipo] += 1;
    const token = `[${ROTULO_POR_TIPO[d.tipo]}_${this.contadores[d.tipo]}]`;
    this.porChave.set(chave, token);
    this.porToken.set(token.toUpperCase(), d.valor); // guarda a 1ª grafia vista
    return token;
  }

  /** Quantos valores distintos por tipo. */
  contagem(): Contagem {
    const out: Contagem = {};
    for (const t of TIPOS_PII) if (this.contadores[t] > 0) out[t] = this.contadores[t];
    return out;
  }

  get tamanho(): number {
    return this.porToken.size;
  }

  /** Restaura os valores; token que não existe fica como está e é contado. */
  destokenizar(texto: string): { texto: string; desconhecidos: number } {
    let desconhecidos = 0;
    const saida = texto.replaceAll(RE_TOKEN, (original, rotulo: string, n: string) => {
      const valor = this.porToken.get(`[${rotulo.toUpperCase()}_${n}]`);
      if (valor === undefined) {
        desconhecidos += 1;
        return original;
      }
      return valor;
    });
    return { texto: saida, desconhecidos };
  }
}
