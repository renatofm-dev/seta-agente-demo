import { type DadosEmissao, formatarData, formatarReais } from '@seta/cobranca';
import type { BotaoTemplate } from '@seta/wa-meta';
import { montarBotaoPix, type PixRecebedor } from './order-details.js';
import type { CobrancaRow, CobrancaTituloRow } from './repo.js';

/**
 * Escolhe o template de cobrança e monta suas variáveis (043).
 *
 * O template só entra em jogo quando a janela de 24h fecha — dentro dela o
 * outbox manda o texto livre de `mensagensEmitida`, que é mais rico. Por isso
 * as variáveis daqui são um resumo do texto, não uma tradução dele.
 *
 * **A ordem das variáveis é o contrato do corpo aprovado na Meta.** Mudar o
 * corpo lá exige mudar a lista aqui: a Meta recusa aridade diferente no envio,
 * e o erro não diz qual template errou.
 */

/** Nomes dos modelos aprovados, do `.env`. Ausente ⇒ aquele método não manda template. */
export interface NomesTemplateCobranca {
  readonly pix?: string;
  readonly boleto?: string;
  readonly boletoSegundaVia?: string;
  readonly cartao?: string;
}

export interface TemplateCobranca {
  readonly nome: string;
  readonly idioma: string;
  readonly variaveis: string[];
  readonly botao?: BotaoTemplate;
}

export interface MontarTemplateOpts {
  readonly recebedor: PixRecebedor | null;
  readonly nomes: NomesTemplateCobranca;
}

export function montarTemplateCobranca(
  dados: DadosEmissao,
  cobranca: Pick<CobrancaRow, 'id' | 'contratoId'>,
  titulos: readonly CobrancaTituloRow[],
  opts: MontarTemplateOpts,
): TemplateCobranca | null {
  const valor = formatarReais(dados.valorCentavos);
  const vencimento = formatarData(dados.vencimento);
  const idioma = 'pt_BR';

  switch (dados.metodo) {
    case 'pix': {
      // o copia-e-cola não cabe em variável de botão nem em COPY_CODE (20
      // chars): viaja dentro do order_details que `montarBotaoPix` monta.
      const botao = montarBotaoPix(
        {
          id: cobranca.id,
          contratoId: cobranca.contratoId,
          metodo: 'pix',
          valorCentavos: dados.valorCentavos,
          pixCopiaCola: dados.pixCopiaCola,
        },
        titulos,
        opts.recebedor,
      );
      if (!botao || !opts.nomes.pix) return null;
      // corpo: {{1}} valor · {{2}} vencimento · {{3}} link
      return {
        nome: opts.nomes.pix,
        idioma,
        variaveis: [valor, vencimento, dados.urlFatura],
        botao,
      };
    }
    case 'boleto': {
      // 2ª via tem texto próprio: reconhece o envio anterior, o que muda a
      // leitura de quem já pagou.
      const nome = dados.reenvio ? opts.nomes.boletoSegundaVia : opts.nomes.boleto;
      // sem linha digitável o template perde a razão de existir — o cotista
      // ficaria com um card mandando copiar um código que não veio.
      if (!nome || !dados.linhaDigitavel) return null;
      // corpo: {{1}} valor · {{2}} vencimento · {{3}} linha digitável · {{4}} PDF
      return {
        nome,
        idioma,
        variaveis: [valor, vencimento, dados.linhaDigitavel, dados.urlBoleto ?? dados.urlFatura],
      };
    }
    case 'cartao': {
      if (!opts.nomes.cartao) return null;
      // corpo: {{1}} valor · {{2}} link
      return { nome: opts.nomes.cartao, idioma, variaveis: [valor, dados.urlFatura] };
    }
  }
}
