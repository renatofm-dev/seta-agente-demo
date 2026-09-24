import type { MetodoPagamento } from '@seta/payment-provider';
import {
  type Candidato,
  type EstadoFluxo,
  opcoesDe,
  selecionados,
  totalSelecionado,
  vencidasDe,
} from './tipos.js';

/**
 * Textos do fluxo (WhatsApp, pt-BR, curtos). Determinísticos: todo valor vem
 * do ERP — não há rascunho de LLM aqui, logo nada para o guardrail de preço
 * corrigir.
 */

export function formatarReais(centavos: number): string {
  const negativo = centavos < 0;
  const abs = Math.abs(centavos);
  const inteiros = Math.floor(abs / 100);
  const resto = abs % 100;
  const milhar = inteiros.toString().replaceAll(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${negativo ? '-' : ''}R$ ${milhar},${resto.toString().padStart(2, '0')}`;
}

/** YYYY-MM-DD (ou ISO completo) → DD/MM/AAAA. */
export function formatarData(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

export const NOME_METODO: Record<MetodoPagamento, string> = {
  boleto: 'boleto',
  pix: 'PIX',
  cartao: 'link de cartão',
};

export function descricaoParcela(c: Candidato): string {
  const numero = c.totalParcelas ? `${c.parcela}/${c.totalParcelas}` : String(c.parcela);
  return `Parcela ${numero} (${c.origem})`;
}

function linhaParcela(c: Candidato): string {
  const quando =
    c.situacao === 'vencida'
      ? `venceu em ${formatarData(c.vencimento)}`
      : `vence em ${formatarData(c.vencimento)}`;
  return `${descricaoParcela(c)} — ${formatarReais(c.valorCentavos)} — ${quando}`;
}

export function textoLista(estado: Pick<EstadoFluxo, 'candidatos'>): string {
  const opcoes = opcoesDe(estado);
  const vencidas = vencidasDe(estado);
  const n = estado.candidatos.length;
  const cabecalho =
    vencidas.length === 0
      ? `Seu contrato está em dia 🙂 Encontrei ${n} parcela(s) em aberto:`
      : `Encontrei ${n} parcela(s) em aberto no seu contrato:`;
  const linhas = opcoes.map((o, i) => {
    if (o.tipo === 'titulo') return `${i + 1}) ${linhaParcela(o.candidato)}`;
    const total = o.candidatos.reduce((acc, c) => acc + c.valorCentavos, 0);
    return `${i + 1}) Todas as vencidas (${o.candidatos.length}) — ${formatarReais(total)}`;
  });
  return `${cabecalho}\n${linhas.join('\n')}\n\nQual você quer pagar? Responda com o número.`;
}

export function textoUnica(c: Candidato): string {
  const prefixo =
    c.situacao === 'a_vencer'
      ? 'Seu contrato está em dia 🙂 A próxima parcela é:\n'
      : 'Encontrei 1 parcela em aberto no seu contrato:\n';
  return `${prefixo}• ${linhaParcela(c)}`;
}

export const TEXTO_METODO =
  'Como você prefere pagar?\n1) Boleto\n2) PIX\n3) Cartão de crédito (link)\nResponda com o número.';

export function textoConfirmacao(
  estado: Pick<EstadoFluxo, 'candidatos' | 'selecao' | 'metodo'>,
): string {
  const itens = selecionados(estado).map(
    (c) => `• ${descricaoParcela(c)} — ${formatarReais(c.valorCentavos)}`,
  );
  const forma = estado.metodo ? NOME_METODO[estado.metodo] : '—';
  return (
    `Confirmando:\n${itens.join('\n')}\n• Total: ${formatarReais(totalSelecionado(estado))}\n` +
    `• Forma: ${forma}\nPosso gerar o pagamento? Responda SIM para confirmar ou NÃO para cancelar.`
  );
}

export function textoGerando(metodo: MetodoPagamento): string {
  return `Perfeito! Estou gerando seu ${NOME_METODO[metodo]}, já te envio aqui. ⏳`;
}

export function textoTeto(totalCentavos: number, metodo: MetodoPagamento): string {
  return (
    `Esse valor (${formatarReais(totalCentavos)}) passa do limite que consigo liberar sozinho. ` +
    `Já pedi a aprovação de um atendente — assim que aprovar, te envio o ${NOME_METODO[metodo]} aqui mesmo.`
  );
}

export function textoBloqueado(motivo: 'cancelado' | 'distrato'): string {
  const situacao = motivo === 'cancelado' ? 'cancelado' : 'com distrato em análise';
  return (
    `Vi que seu contrato está ${situacao}. Nesse caso o pagamento precisa passar por um ` +
    'atendente — já acionei a equipe.'
  );
}

export const TEXTO_SEM_DOCUMENTO =
  'Para gerar o pagamento preciso do CPF do titular no cadastro. Já acionei um atendente para validar com você.';

export function textoLimiteDia(n: number): string {
  return (
    `Já geramos ${n} pagamento(s) hoje nesta conversa. Para gerar outro, um atendente vai te ` +
    'ajudar — já acionei a equipe.'
  );
}

export const TEXTO_EM_DIA =
  'Boa notícia: seu contrato está em dia e não há parcela em aberto no momento. 🙂';

export const TEXTO_NAO_ENTENDI =
  "Não entendi 😅 Responda só com o número da opção (ex.: 1), ou 'cancelar' para deixar pra depois.";

export const TEXTO_CANCELADO =
  "Tudo bem, deixo o pagamento de lado. Quando quiser retomar é só dizer 'quero pagar'. 🙂";

export const TEXTO_FALHA_EMISSAO =
  'Não consegui gerar o pagamento agora. Já acionei um atendente para resolver — você recebe o retorno aqui.';

export const TEXTO_RECUSADO =
  'O pagamento pelo WhatsApp não foi liberado desta vez. Um atendente vai falar com você por aqui para combinar a melhor forma.';

export const TEXTO_INTERESSE_COMPRA =
  'Que bom que você quer ampliar sua participação! Isso quem cuida é a nossa equipe comercial — ' +
  'já passei seu contato e alguém fala com você aqui mesmo. Enquanto isso, posso ajudar com o seu contrato atual. 🙂';

export interface DadosEmissao {
  readonly metodo: MetodoPagamento;
  readonly valorCentavos: number;
  /** YYYY-MM-DD */
  readonly vencimento: string;
  readonly urlFatura: string;
  readonly urlBoleto: string | null;
  readonly linhaDigitavel: string | null;
  readonly pixCopiaCola: string | null;
  readonly reenvio: boolean;
}

/** Mensagens da cobrança emitida: explicação + (boleto/PIX) o código sozinho, para copiar. */
export function mensagensEmitida(d: DadosEmissao): string[] {
  const valor = formatarReais(d.valorCentavos);
  const prefixo = d.reenvio
    ? `Você já tinha um ${NOME_METODO[d.metodo]} gerado para essas parcelas — reenviando:\n`
    : '';
  switch (d.metodo) {
    case 'boleto': {
      const link = d.urlBoleto ?? d.urlFatura;
      const msgs = [
        `${prefixo}Seu boleto está pronto! 🧾\nValor: ${valor} — vence em ${formatarData(d.vencimento)}\n` +
          `Link: ${link}` +
          (d.linhaDigitavel
            ? '\nA linha digitável vem na próxima mensagem, é só copiar no app do banco.'
            : ''),
      ];
      if (d.linhaDigitavel) msgs.push(d.linhaDigitavel);
      return msgs;
    }
    case 'pix': {
      /**
       * O link vai SEMPRE, como no boleto — e não só quando falta o
       * copia-e-cola. O BR Code do PIX carrega um domínio dentro do payload
       * (`...br.gov.bcb.pix2560pix-h.asaas.com/qr/cobv/...`), e o WhatsApp
       * transforma esse pedaço em link. Sem um link de verdade na mensagem, a
       * única coisa tocável da conversa era aquele — que não abre página
       * nenhuma. Quem toca não sabe que tocou num fragmento de código.
       */
      const msgs = [
        `${prefixo}Seu PIX está pronto! ⚡\nValor: ${valor} — válido até ${formatarData(d.vencimento)}` +
          `\nPague pelo link: ${d.urlFatura}` +
          (d.pixCopiaCola ? '\nOu use o código copia-e-cola do PIX.' : ''),
      ];
      if (d.pixCopiaCola) msgs.push(d.pixCopiaCola);
      return msgs;
    }
    case 'cartao':
      return [
        `${prefixo}Seu link de pagamento está pronto! 💳\nValor: ${valor}\n${d.urlFatura}\n` +
          'O pagamento é feito na página segura — eu nunca peço dados do cartão por aqui.',
      ];
  }
}

export function textoPago(valorCentavos: number, parcelas: readonly Candidato[]): string {
  const quais = parcelas.map(descricaoParcela).join(', ');
  return (
    `Pagamento confirmado! ✅ Recebemos ${formatarReais(valorCentavos)} referente a ${quais}. ` +
    'A baixa já consta no seu contrato. Obrigado!'
  );
}
