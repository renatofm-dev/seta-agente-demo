# 044 — cobrança proativa: do disparo ao pagamento confirmado

> **ENTREGUE em 15/10/2026.** Carteira inadimplente no console, opt-out, variável por
> destinatário, emissão e ritmo de envio — provado em produção (3 cobranças, 3 mensagens
> entregues, pagamento e baixa automática no ERP). **Duas ressalvas**: a seleção do público
> **não** ficou no catálogo (ver os critérios abaixo) e o funil da 017 ainda não conta a campanha
> (issue #53). Detalhes em [`docs/dev/04-modulos-entregues.md`](../docs/dev/04-modulos-entregues.md).
>
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
1. ⚠️ **parcial** — a campanha emite uma cobrança por destinatário e manda a mensagem com o
   link e o código **daquela** pessoa (conferido em campo com três valores diferentes), mas o
   público **não vem do catálogo**. `financeiro.titulos_atraso` responde "o que está vencido
   NESTE contrato" (`source: session`), e não existe origem "operador" — criá-la mexeria no bind
   que impede o LLM de escolher de qual contrato lê. Além disso a inadimplência vive no banco do
   ERP e a carteira no do app, com credenciais diferentes: não há `JOIN`. A seleção é server-side,
   em duas etapas, com bind nomeado.
2. Quem está na lista de supressão não recebe e aparece como recusado na resposta da
   criação; a palavra de saída insere na lista e responde ao cotista.
3. ⚠️ **não verificado em campo** — a conversa é criada sem tocar a janela, e a resposta do
   cotista deve abri-la e cair no turno normal. O caminho existe (é o mesmo da 013), mas ninguém
   respondeu a uma cobrança ativa ainda.
4. ⚠️ **parcial** — pagar dispara a confirmação e a baixa no ERP (verificado em 15/10), mas o
   **funil da campanha não conta** a cobrança ativa: o relatório da 017 é construído sobre
   `disparo`, e a campanha reusa o caminho da 014 sem criar um. Issue #53.
5. ⚠️ **parcial** — recusa com motivo visível no plano (`suprimido`, `acima_do_teto`,
   `cobranca_em_aberto`, `contrato_repetido`) e falha de um não interrompe os demais (testado).
   **Sem CPF** ainda bloqueia só na emissão, pela 014, e não aparece como recusa no plano.
6. Um disparo da 013, sem variável por destinatário, continua funcionando igual.
7. `pnpm lint && pnpm test && pnpm build` verdes.
