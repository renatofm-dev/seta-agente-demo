import {
  type CotaDisponivel,
  cotaEscolhida,
  type EstadoFluxo,
  type Perfil,
  pisoCentavos,
} from './tipos.js';

/**
 * Textos do fluxo (WhatsApp, pt-BR, curtos). Determinísticos: todo valor vem do
 * ERP ou da aritmética do piso. REGRA (spec 015): fala-se em VALOR, nunca em
 * percentual — nada de "%", "desconto", "abatimento", "cortesia", "preço
 * especial", "condição especial", "baixar o preço" nem "faço por". É o
 * vocabulário do guardrail de preço; usar "fecho em R$ X" / "está R$ X".
 */

export function formatarReais(centavos: number): string {
  const negativo = centavos < 0;
  const abs = Math.abs(centavos);
  const inteiros = Math.floor(abs / 100);
  const resto = abs % 100;
  const milhar = inteiros.toString().replaceAll(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${negativo ? '-' : ''}R$ ${milhar},${resto.toString().padStart(2, '0')}`;
}

function tierLegivel(tier: string): string {
  return tier
    .toLowerCase()
    .split(/\s+/)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
}

function blocoLegivel(bloco: string): string {
  return bloco.toLowerCase().replace(/^torre\s*/, 'Torre ');
}

export function descricaoCota(c: CotaDisponivel): string {
  const periodos = c.periodos === 1 ? '1 período/ano' : `${c.periodos} períodos/ano`;
  return (
    `${tierLegivel(c.tier)} — ${blocoLegivel(c.bloco)}, apto ${c.uh}, até ${c.capacidade} ` +
    `hóspedes, ${periodos}`
  );
}

export const TEXTO_QUALIFICACAO_PESSOAS =
  'Que bom que você tem interesse em uma cota do resort! 🙂 Para te mostrar as opções ' +
  'certas: quantas pessoas costumam viajar com você?';

export const TEXTO_QUALIFICACAO_PERIODOS =
  'Perfeito. E quantas vezes por ano você gostaria de usar o resort? Responda 1, 2 ou 3.';

export function textoLista(estado: Pick<EstadoFluxo, 'opcoes' | 'perfil'>): string {
  const p = estado.perfil;
  const vezes = p.periodos === 1 ? '1 vez por ano' : `${p.periodos} vezes por ano`;
  const cabecalho = `Encontrei estas opções para ${p.pessoas} pessoa(s), ${vezes}:`;
  const linhas = estado.opcoes.map(
    (c, i) => `${i + 1}) ${descricaoCota(c)} — ${formatarReais(c.valorTabelaCentavos)}`,
  );
  return `${cabecalho}\n${linhas.join('\n')}\n\nQual você quer ver de perto? Responda com o número.`;
}

export function textoOfertaTabela(estado: Pick<EstadoFluxo, 'opcoes' | 'escolha'>): string {
  const c = cotaEscolhida(estado);
  if (!c) return '';
  return (
    `A cota ${c.cotaCodigo} (${descricaoCota(c)}) está ${formatarReais(c.valorTabelaCentavos)} ` +
    'à vista. Fechamos? Responda SIM, ou me diga o que você precisa.'
  );
}

export function textoOfertaPiso(
  estado: Pick<EstadoFluxo, 'opcoes' | 'escolha'>,
  bps: number,
): string {
  const c = cotaEscolhida(estado);
  if (!c) return '';
  const piso = pisoCentavos(c.valorTabelaCentavos, bps);
  return (
    `Consigo fechar a ${c.cotaCodigo} em ${formatarReais(piso)} à vista — é o melhor valor que ` +
    'consigo por aqui. Fechamos?'
  );
}

export const TEXTO_JA_NO_PISO =
  'Esse é realmente o melhor valor que consigo por aqui. Podemos fechar assim, ou eu peço ' +
  'para o comercial avaliar outra proposta com você — o que prefere?';

export function textoAlcada(pedidoCentavos: number): string {
  return (
    `${formatarReais(pedidoCentavos)} passa da minha alçada. Já pedi para o comercial avaliar ` +
    'sua proposta — você recebe o retorno aqui mesmo. 🙂'
  );
}

export const TEXTO_AGENDAMENTO =
  'Ótimo! 🎉 Para o comercial fechar com você: me diga seu nome e o melhor horário para ligar.';

export function textoAgendado(perfil: Pick<Perfil, 'contato'>): string {
  return (
    `Combinado! O comercial entra em contato (${perfil.contato ?? 'no horário combinado'}). ` +
    'Obrigado pelo interesse!'
  );
}

export const TEXTO_SEM_ESTOQUE =
  'No momento não tenho cota disponível com esse perfil. Já passei para o comercial, que ' +
  'pode ver alternativas com você — o retorno vem aqui mesmo.';

export function textoLimiteDia(n: number): string {
  return (
    `Já apresentei ${n} proposta(s) hoje nesta conversa. Para seguir, o comercial vai te ` +
    'atender — já acionei a equipe.'
  );
}

export const TEXTO_NAO_ENTENDI =
  "Não entendi 😅 Responda só com o número (ex.: 2), ou 'não tenho interesse' para encerrar.";

export const TEXTO_SEM_INTERESSE = 'Tudo bem! Se mudar de ideia, é só me chamar por aqui. 🙂';

// --- 045: fechamento com sinal por PIX --------------------------------------

/**
 * O pedido de nome e CPF. Só acontece DEPOIS do aceite, e só na raia do lead
 * frio: quem já é cotista tem os dois no cadastro. É a mesma ordem da 038 —
 * nenhum dado pessoal é pedido antes de o negócio estar de pé.
 */
export const TEXTO_DADOS =
  'Combinado! Para emitir o sinal eu preciso de duas informações: seu *nome completo* e seu ' +
  '*CPF*. Pode mandar os dois na mesma mensagem. 🙂';

export const TEXTO_DADOS_INVALIDOS =
  'Não consegui ler o CPF 😅 Pode mandar de novo, com o nome completo e os 11 dígitos?';

export function textoSinalEmitido(sinalCentavos: number, totalCentavos: number): string {
  return (
    `Perfeito! Para garantir a unidade, o sinal é de ${formatarReais(sinalCentavos)} ` +
    `(o total fica em ${formatarReais(totalCentavos)}). ` +
    'Estou te mandando o PIX aqui embaixo — assim que cair, eu confirmo por aqui. 👇'
  );
}

export const TEXTO_AGUARDANDO_SINAL =
  'Ainda não identifiquei o pagamento do sinal. Assim que ele cair eu te aviso por aqui! Se ' +
  'preferir falar com alguém da equipe, é só dizer.';

export function textoVendido(contratoErp: string): string {
  return (
    `Pagamento confirmado e contrato registrado! 🎉 Seu contrato é o *${contratoErp}*. ` +
    'A partir de agora você já pode consultar parcelas e reservar sua semana por aqui.'
  );
}

/** Todos os textos fixos — o teste de vocabulário varre isto + os renders. */
export const TEXTOS_FIXOS: readonly string[] = [
  TEXTO_QUALIFICACAO_PESSOAS,
  TEXTO_QUALIFICACAO_PERIODOS,
  TEXTO_JA_NO_PISO,
  TEXTO_AGENDAMENTO,
  TEXTO_SEM_ESTOQUE,
  TEXTO_NAO_ENTENDI,
  TEXTO_SEM_INTERESSE,
  TEXTO_DADOS,
  TEXTO_DADOS_INVALIDOS,
  TEXTO_AGUARDANDO_SINAL,
];
