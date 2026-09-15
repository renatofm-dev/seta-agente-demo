# 044 — cobrança proativa: do disparo ao pagamento confirmado

> **Pré-spec** (rascunho de 15/09/2026): terceira etapa da
> [frente de pagamentos](../docs/roadmap-pagamentos-whatsapp.md). Depende da
> [042](042-asaas-sandbox-real.md) e da [043](043-template-pagamento-pix.md). É a etapa que
> fecha o ciclo da demo.

## Objetivo
Hoje a cobrança só começa se o cotista escrever primeiro. A plataforma sabe quem está
inadimplente (o catálogo responde isso), sabe emitir cobrança e sabe receber a confirmação —
mas não sabe **abrir a conversa**. Esta spec liga as pontas: seleciona a carteira pelo
catálogo, dispara o template de cobrança com link e PIX **de cada pessoa**, recebe a
resposta no fluxo que já existe e fecha com o "pagamento confirmado".

## Reaproveita
- `apps/server/src/wa/disparo.ts:50-121` — worker de disparo, falha isolada por
  destinatário, mensagem na thread com `autor: 'campanha'`.
- `apps/server/src/disparos-routes.ts:145-208` — criação do disparo, validação de carteira e
  de contagem de variáveis, limite de 500 destinatários.
- `apps/server/src/wa/routes.ts:28-92` — funil `sent|delivered|read|failed` casando por
  `wa_message_id`.
- `packages/query-catalog` — `financeiro.titulos_atraso` já devolve quem deve.
- O fluxo de cobrança inteiro da 014 e o montador de template da 043.
- `apps/server/src/relatorios-routes.ts:266-288` — o funil de campanha da
  [017](017-relatorio-campanhas.md), que passa a ter cobrança proativa como origem.

## Escopo

### Variável por destinatário
`disparo.variaveis` é um JSONB **global ao disparo** (`apps/server/src/db/schema.ts:161-162`):
serve para "sua parcela vence amanhã", não para uma cobrança cujo link e código PIX mudam a
cada pessoa. Migração: as variáveis passam a viver em `disparo_destinatario`, com o valor
global continuando válido como default para os disparos da 013 — nenhum disparo existente
muda de comportamento.

### Seleção da carteira
- Origem do público pelo catálogo (`financeiro.titulos_atraso` com faixa de atraso e valor),
  não por lista colada à mão.
- O público é **materializado no momento da criação** do disparo, com o snapshot do que
  gerou cada destinatário — quem pagou entre a seleção e o envio não recebe cobrança.

### Emissão antes do envio
Cada destinatário precisa de uma cobrança emitida para ter link e PIX. O disparo passa a ter
uma etapa de preparação que emite as cobranças pelo caminho da 014 (mesma referência
determinística, mesmo teto de HITL, mesmos bloqueios) e só envia o template de quem foi
emitido com sucesso. Quem cair na alçada humana fica aguardando aprovação e é enviado
depois; quem estiver bloqueado (contrato cancelado, sem CPF) não recebe nada.

### Opt-out
Não existe **uma linha** de supressão no repositório, e envio proativo sem ela é risco de
qualidade do número na Meta:
- tabela de supressão por `wa_id`, com origem (pedido do cotista, erro de envio recorrente,
  cadastro manual) e data;
- palavra de saída reconhecida no inbound, com confirmação para o cotista;
- consulta obrigatória antes de cada destinatário, no worker e na criação do disparo — quem
  está suprimido aparece na resposta como recusado, não some em silêncio;
- Console › Campanhas mostra a contagem de suprimidos do disparo.

### Ritmo de envio
O worker é um laço sequencial sem pausa, sem backoff e sem retry (`disparo.ts:79`). Para
cobrança, isso é agressivo com os limites da Meta: entra um intervalo configurável entre
envios e uma parada automática se a taxa de falha passar de um limiar — melhor parar um
disparo do que queimar o número.

## Fora de escopo
- Agendamento de campanha e segmentação genérica — [030](030-campanha-segmentada.md).
- Régua de cobrança com várias tentativas ao longo do tempo (esta spec entrega **um**
  disparo; a régua é decisão de produto).
- Negociação de desconto ou parcelamento pelo agente — [031](031-sdr-fase-2.md).
- Baixa no ERP — [036](036-erp-escrita-baixa.md).
- Produção com dinheiro real — [027](027-asaas-producao.md).

## Premissas
- Roda no sandbox do Asaas e no número de teste da Meta, com os contatos do
  `contatos.yaml` — nenhum cotista real é cobrado por esta spec.
- O template da 043 está aprovado em categoria utility.
- O limite de 500 destinatários por disparo continua valendo.

## Critérios de aceite
1. Um disparo de cobrança criado a partir do catálogo emite uma cobrança por destinatário e
   envia o template com o link e o PIX **daquela** pessoa — conferido em dois destinatários
   com valores diferentes.
2. Quem está na lista de supressão não recebe e aparece como recusado na resposta da
   criação; a palavra de saída insere na lista e responde ao cotista.
3. Quem responde ao template cai no fluxo de cobrança normal, na mesma conversa, com a
   janela de 24 h aberta pela resposta.
4. Pagar uma das cobranças dispara a confirmação, e o funil da campanha contabiliza
   entregue, lido, respondido, cobrado e pago.
5. Destinatário bloqueado (sem CPF, contrato cancelado) não recebe e fica registrado com o
   motivo; falha de um não interrompe o disparo.
6. Um disparo da 013, sem variável por destinatário, continua funcionando igual.
7. `pnpm lint && pnpm test && pnpm build` verdes.
