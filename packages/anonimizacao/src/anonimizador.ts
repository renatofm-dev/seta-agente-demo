import { Cofre } from './cofre.js';
import { resolverSobreposicao } from './sobreposicao.js';
import type { Contagem, Deteccao, Detector } from './tipos.js';

/**
 * Roda os detectores, resolve sobreposição e substitui do fim para o início
 * para não deslocar offsets. Estrito: erro de detector propaga — quem decide
 * degradar é o detector (o NER degrada; regex e dicionário não têm por quê
 * falhar).
 */

export { resolverSobreposicao } from './sobreposicao.js';

export interface ResultadoAnonimizacao {
  readonly textos: string[];
  readonly cofre: Cofre;
  readonly substituicoes: Contagem;
  readonly total: number;
}

export interface Anonimizador {
  readonly detectores: readonly string[];
  anonimizar(textos: readonly string[], cofre?: Cofre): Promise<ResultadoAnonimizacao>;
}

export function createAnonimizador(cfg: { detectores: readonly Detector[] }): Anonimizador {
  return {
    detectores: cfg.detectores.map((d) => d.nome),
    async anonimizar(textos, cofreExistente) {
      const cofre = cofreExistente ?? new Cofre();
      const saida: string[] = [];
      let total = 0;
      for (const texto of textos) {
        if (!texto) {
          saida.push(texto);
          continue;
        }
        const achados: Deteccao[] = [];
        for (const det of cfg.detectores) {
          achados.push(...(await det.detectar(texto)));
        }
        const finais = resolverSobreposicao(achados);
        let novo = texto;
        for (let i = finais.length - 1; i >= 0; i--) {
          const d = finais[i] as Deteccao;
          novo = novo.slice(0, d.inicio) + cofre.token(d) + novo.slice(d.fim);
        }
        total += finais.length;
        saida.push(novo);
      }
      return { textos: saida, cofre, substituicoes: cofre.contagem(), total };
    },
  };
}
