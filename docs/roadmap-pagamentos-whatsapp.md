# Roadmap da frente de pagamentos — Asaas real e template de PIX no WhatsApp

**Aberta em:** 15/09/2026 · **Escopo:** pré-specs [042](../specs/042-asaas-sandbox-real.md),
[043](../specs/043-template-pagamento-pix.md) e [044](../specs/044-cobranca-proativa.md)

Este documento cobre uma frente só. O calendário dos marcos, as decisões D1–D10 e o backlog
da empresa continuam em [`roadmap.md`](roadmap.md); o que cada spec entregou está em
[`dev/04-modulos-entregues.md`](dev/04-modulos-entregues.md).

## Por que esta frente existe

A cobrança pelo WhatsApp foi construída inteira na [spec 014](../specs/014-cobranca-pagamento.md)
e nunca falou com o Asaas. O adapter existe, tem teste, trata os erros da API — mas
`apps/server/src/index.ts:63-66` escolhe o provedor pela presença de `ASAAS_API_KEY`, que
não está configurada. Sem ela, tudo roda no provider simulado: ids fictícios, PIX fictício,
e o botão "Simular pagamento" injetando o evento à mão.

Do lado do WhatsApp existe um template de cobrança aprovado na WABA — card com o valor, o
**link de pagamento** no corpo e um botão **"Copy Pix code"**. O código não sabe montar essa
mensagem: `packages/wa-meta/src/template.ts:176-196` só produz `components` de corpo com
parâmetros de texto.

Os dois lados se encaixam sem nada novo no meio. O link do corpo é a `invoiceUrl` que o
Asaas devolve ao criar a cobrança; o código do botão é o copia-e-cola que
`obterPix` já busca. **A frente é ligar o que existe, não construir de novo.**

## Onde estamos

| | Estado |
|---|---|
| Port `PaymentProvider`, adapter Asaas, erros tipados | ✅ exercitado contra o sandbox real (042) |
| Máquina de estados, teto de HITL, referência idempotente | ✅ pronto |
| Webhook do Asaas autenticado e idempotente | ✅ recebendo evento real pelo túnel; evento preso tem reprocesso (042) |
| Conciliação (compensa o ERP read-only) | ✅ pronto |
| Console › Cobranças, aprovar, recusar, simular | ✅ pronto — simular agora é barrado em produção (042) |
| Envio de template sem janela de 24 h | ✅ corpo + botão `order_details` (043); header de mídia é a 033 |
| Cadastro e sync de template na WABA | ✅ pronto, exige `WA_WABA_ID` (ausente) |
| Disparo em lote com funil entregue/lido | ✅ pronto, variáveis globais ao disparo |
| Aviso de pagamento fora da janela de 24 h | ✅ os dois ramos com teste (043) |
| Opt-out / lista de supressão | ❌ não existe |

## As três etapas

A **042 e a 043 foram entregues em 15/09/2026** (PRs #20 e #21) — o que cada uma expôs está no
fim da respectiva spec, no diagnóstico do [`asaas-setup.md`](asaas-setup.md) e nas seções 6 e
7 do [`meta-setup.md`](meta-setup.md). Resta uma:

| Etapa | O que fecha | Depende | Issue |
|---|---|---|---|
| [044 — cobrança proativa](../specs/044-cobranca-proativa.md) | a plataforma abre a conversa com quem deve, e o ciclo fecha sozinho até o "pagamento confirmado" | 042, 043 | — |

A 044 já tem as duas peças de que precisava: cobrança real com link e PIX (042) e o template
que os leva ao WhatsApp fora da janela (043). O que falta nela é variável por destinatário e
o opt-out.

### 042 — Asaas de verdade no sandbox ✅ 15/09/2026

Ligar a chave não foi código — foi `.env` e o webhook publicado pelo túnel, que
`tools/dev-whatsapp.sh` já sabia registrar e desligar. O código veio do que a primeira
validação real cobrou:

- **reprocessar evento que falhou.** `evento_psp.processado_em` só era preenchido quando
  não houve erro, e a reentrega do Asaas batia no `onConflictDoNothing` por id — o evento
  ficava parado para sempre. Agora a tela de Cobranças conta os pendentes e a lista
  (`GET /api/console/eventos-psp?pendente=true`) é a única superfície que alcança os
  órfãos, com botão de reprocesso.
- **`simular-pagamento` não pode existir em produção.** A guarda era só `DEV_SIMULATOR`;
  agora exige também `psp.ambiente !== 'producao'`, computado no server para o console não
  duplicar a regra.
- **e três coisas que ninguém tinha previsto:** a chave do Asaas começa com `$` e o
  `dev-whatsapp.sh` sourceia o `.env` pelo shell (sem aspas, o webhook não registrava, em
  silêncio); o id de evento do Asaas contém `&`; e o `post()` do console mandava
  `content-type: application/json` sem corpo, o que já quebrava *Aprovar* e *Simular
  pagamento* com 500. Detalhes no fim da [spec](../specs/042-asaas-sandbox-real.md).

### 043 — template de pagamento com PIX ✅ 15/09/2026

Começou descobrindo, e a descoberta mudou tudo: o template aprovado é **_order details_** — o
fluxo de pagamentos do Brasil. O envio continua `type: template`, mas o botão carrega um
pedido inteiro (`payment_settings` com o copia-e-cola, `total_amount`, itens).

O caminho "pequeno" nunca existiu: `COPY_CODE` aceita **20 caracteres** e o copia-e-cola do
Asaas tem **180**.

A elegibilidade — o risco nº 1, que a doc da Meta não documenta — foi resolvida por sonda:
com a WABA verificada e `account_review_status: APPROVED`, a Meta aceitou sem onboarding
extra de WhatsApp Pay. No aparelho, o botão abre o pagamento com valor e recebedor corretos.

A decisão texto × template ficou no **worker do outbox**, não na emissão: a janela de 24 h
pode fechar entre o INSERT e o envio, e o ramo que antes só desistia (`janela_fechada` +
ticket) agora reengaja sozinho quando a linha traz um template.

### 044 — cobrança proativa

Junta as duas e fecha o ciclo: seleciona a carteira inadimplente pelo catálogo, dispara o
template com **link e PIX por destinatário**, recebe a resposta no fluxo de cobrança que já
existe e confirma o pagamento pelo template da 043.

A mudança de modelo está aqui: hoje `disparo.variaveis` é um JSONB **global ao disparo** —
serve para "sua parcela vence amanhã", não para uma cobrança cujo link muda a cada pessoa.

E entra o **opt-out**, que não existe em nenhuma linha do repositório. Envio proativo sem
lista de supressão é risco de qualidade na Meta e de reclamação do cotista.

## O que não é código

Nada aqui anda sem estas quatro coisas, e nenhuma delas depende do time de desenvolvimento:

| O quê | Onde | Trava |
|---|---|---|
| ~~Conta sandbox do Asaas e chave de API~~ | [`asaas-setup.md`](asaas-setup.md) | ✅ feito (042) |
| ~~CPF do titular no vínculo (`documento` no `contatos.yaml`)~~ | o Asaas exige `cpfCnpj` e o ERP não expõe CPF ao papel de leitura | ✅ feito (042) |
| ~~`WA_WABA_ID` e o nome exato do template aprovado~~ | [`meta-setup.md`](meta-setup.md) | ✅ feito (043) |
| Templates submetidos na categoria **utility** | a Meta pode recategorizar para marketing | 043, 044 |

## Riscos

| Risco | Efeito | O que fazemos |
|---|---|---|
| ~~O template aprovado é _order details_~~ | **confirmado** em 15/09/2026 — e implementado: a Meta aceitou sem onboarding extra de WhatsApp Pay | resolvido na 043 |
| A Meta recategoriza o template para marketing | custo por mensagem e regras de opt-in mudam | `modelo_mensagem.categoria` já existe; o botão sincronizar reflete |
| Cobrança proativa sem supressão | reclamação derruba a qualidade do número | opt-out é escopo da 044, não "depois" |
| Confundir sandbox com produção | cobrança real sem querer | o ambiente sai do `ASAAS_BASE_URL` e é logado no boot; a 042 fecha a brecha do `simular-pagamento` |

## Onde esta frente para

**No sandbox.** Cobrança com dinheiro de verdade é a [027](../specs/027-asaas-producao.md),
condicionada à decisão **D1** dos sócios (pagamentos entram no piloto, com que teto), que
segue pendente. O número comercial do cliente e os templates definitivos são a
[023](../specs/023-waba-do-cliente.md), presas à **D4** e à **D7**.

Nenhuma das três etapas aqui depende dessas decisões — é justamente o ponto: dá para ter a
demo inteira funcionando antes de os sócios decidirem qualquer coisa.

## Como este documento se mantém

Muda por PR, como o resto do repositório. Quando uma pré-spec vira spec, ganha data e PR no
cabeçalho e sai da tabela das três etapas; quando é entregue, a linha some daqui e aparece
em [`dev/04-modulos-entregues.md`](dev/04-modulos-entregues.md).
