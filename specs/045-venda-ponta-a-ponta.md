# 045 — Venda de ponta a ponta: do interesse ao contrato, com sinal por PIX

> **Entregue em 17/09/2026.** O que saiu está em
> [`docs/dev/04-modulos-entregues.md`](../docs/dev/04-modulos-entregues.md); o ato novo em
> [`docs/roteiro-demo.md`](../docs/roteiro-demo.md).
>
> **Executada inteira (045a + 045b numa sessão), a pedido do Renato.** Sexta fatia da frente
> **demo ponta a ponta**. **Absorve a [039](039-sdr-escreve-no-erp.md)** e acrescenta o elo que
> faltava: o pagamento. Depende da **036** (`ErpWriter`), da **042/043** (Asaas real em sandbox e
> template com PIX) e do fix do classificador (PR #28). Tamanho **G** — ver o fatiamento no fim.
>
> **Decisões do Renato, registradas antes de começar:**
>
> 1. **As duas raias vendem.** Número externo (sem vínculo) é lead frio e usa o SDR que já existe.
>    O número do Renato **continua cotista** e passa a poder comprar — hoje escala. Isso abre a
>    raia do cotista para interesse de compra, que era da [031](031-sdr-fase-2.md).
> 2. **O PIX cobra o sinal, não o valor integral.** Um card de WhatsApp com R$ 202.002,50 não é
>    crível como PIX, e multipropriedade vende com sinal. O restante nasce como parcelas no ERP.
> 3. **A venda vira contrato no ERP** (`vendats/SetVenda` → `IdContrato`), com as parcelas em
>    `contafinanceira`. Sem isso a venda morre na nossa tabela — a crítica que originou esta spec.

## Objetivo

A [015a](015-sdr-lead-frio.md) entregou um SDR que qualifica, apresenta o estoque real e monta a
proposta dentro de uma alçada. E termina ali: `packages/sdr/src/maquina.ts:36-40` tem dois
encerramentos, `agendado` e `aguardando_aprovacao`, e **os dois entregam o lead a um humano**. Nada
chega ao ERP; o lead vira linha em `lead`/`proposta_sdr` e morre lá.

Ao mesmo tempo, a frente de pagamentos já fechou o ciclo do dinheiro: a **042** pôs o Asaas de
verdade no sandbox e a **043** descobriu e implementou o template `cobranca_pix`, com **link no
corpo e PIX copia-e-cola no botão `ORDER_DETAILS`** — aprovado na WABA que a demo usa hoje
(confirmado em 17/09: `cobranca_pix`, UTILITY, APPROVED, 3 variáveis).

Esta spec liga as duas pontas. O interessado conversa, recebe a oferta, aceita, **recebe o PIX do
sinal no WhatsApp**, paga — e o pagamento confirmado cria o contrato de multipropriedade no TS
Explorer.

## Reaproveita

- `packages/sdr` — máquina determinística, parser, aritmética inteira do piso em bps, `render.ts`.
  Ganha duas etapas e um efeito; o miolo de qualificação/oferta não muda.
- `packages/cobranca` e `apps/server/src/pagamentos/*` — o fluxo do dinheiro inteiro: `emitir.ts`
  (cria cliente e cobrança no PSP), `template-cobranca.ts` + `order-details.ts` (o card com PIX da
  043), `webhook-routes.ts` e `eventos.ts` (confirmação), `escalar.ts` (HITL).
- `apps/server/src/reserva/*` (038) — **o molde exato do que esta spec faz**: fluxo persistido,
  confirmação determinística, escrita no ERP por job pg-boss sob `erp_escrita`, read-back por chave
  natural, tela no console. Copiar a forma, não reinventar.
- `packages/erp-api-tse` (036) — `ErpWriter` ganha os métodos comerciais; `erp_escrita` ganha
  `operacao='lead'|'venda'` (os valores **já existem** em `OPERACOES_ERP`).
- `apps/tse-sim` (035) — as rotas comerciais entram aqui. **Os fixtures do fornecedor já existem**
  para todas elas (ver Premissas), o que reduz muito o risco de contrato.
- `packages/guardrails/src/preco.ts` e o `price_source` do catálogo — o piso continua sendo política
  nossa, e o guardrail não muda.

## Escopo

### Simulador (`apps/tse-sim`)

Rotas novas, todas com fixture real na coleção:

| Rota | Fixture | Observação |
|---|---|---|
| `POST /api/recepcaots/setcasal/0` | `aproach-control__create-lead` | **devolve `""`** |
| `GET /api/recepcaots/GetCasal/{id}` | `aproach-control__getting-lead` | read-back |
| `GET /api/recepcaots/GetCasaisPorPeriodo` | — | busca por período p/ achar o `IdCasal` |
| `POST /api/vendats/SetVenda/0` | `sales__create-new-sale` | devolve `"IdContrato: 285"` |
| `POST /api/cadastros/SetPessoa` | `general-registers__create-person` | comprador |
| `GET /api/Lookup/Produtos` | `lookups__getting-products` | `ValorVista`, pontos |
| `GET /api/Lookup/CotasByProduto` | `lookups__getting-quotas-by-product` | `Status: DISPONIVEL` |
| `GET /api/Lookup/{OrigensVenda,TiposRelacionamento,MeiosPagamentoContasReceber,BandeirasCartao}` | `lookups__*` | referenciados por `SetVenda` |

Persistência em `tse_sim.casal` (nova) e, para a venda, **linhas reais em `contrato` e
`contafinanceira`** — é o que faz a demo fechar: o lead vira cotista e passa a ter parcelas, e
`utilizacaocontrato/obtercontratos?cpf=` passa a devolver o contrato novo.

### Adapter (`packages/erp-api-tse`)

- `ErpWriter.criarLead(LeadInput) → { casalId }` — `setcasal` + read-back (ver Premissas).
- `ErpWriter.criarVenda(VendaInput) → { contratoId }` — regex estrita sobre a prosa
  (`/IdContrato:\s*(\d+)/i`, no molde de `ID_DA_PROSA` em `cliente.ts`); `ErpBusinessError` se não
  casar. **200 com prosa inesperada é erro, não sucesso.**
- `ErpWriter.criarPessoa(PessoaInput) → { pessoaId }` para o comprador.

### `packages/sdr` — a máquina fecha em vez de agendar

Etapas novas entre `oferta` e `encerrado`:

```
oferta ──(aceitar)──► dados ──(nome + CPF)──► fechamento ──(sinal pago)──► encerrado:vendido
                        │                          │
                        └─(cotista: já tem CPF)─────┘
```

- **`dados`** só existe na raia do lead frio: coleta nome completo e CPF. Na raia do cotista a etapa
  é **pulada** — o CPF já está em `contato.documento` (014), como a 038 faz com o hóspede titular.
- **`fechamento`**: efeito `emitir_sinal`; o server cria a cobrança e o card do PIX sai pelo
  template. A máquina fica aguardando o evento de pagamento, que chega pelo webhook.
- `agendamento` **continua existindo** como saída alternativa ("prefiro falar com alguém"), e
  `aguardando_aprovacao` continua indo ao console (015b, que esta spec **não** implementa — ver
  Fora de escopo).
- `ENCERRAMENTOS` ganha `vendido`.

`render.ts` ganha os textos, sujeitos ao vocabulário proibido de sempre (valor, nunca percentual).

### Raia do cotista (decisão 1)

`turno-handler.ts:534` hoje é: `comprar_cota` **sem** vínculo inicia o SDR, **com** vínculo escala.
Passa a iniciar o SDR nas duas, com o contexto certo:

- sem vínculo: lead frio, como hoje;
- com vínculo: o fluxo começa sabendo o contrato atual (tier, períodos) e **pula a etapa `dados`**.

**A precedência na raia do cotista passa a ter três fluxos** — cobrança, reserva e venda. A ordem do
bloco de "fluxo ativo" (`turno-handler.ts:440-470`) é cobrança → reserva → venda: quem tem dinheiro
em jogo fala primeiro. Isso precisa de teste próprio, porque é a primeira vez que três fluxos
disputam a mesma raia.

### Cobrança do sinal

Reusa o encanamento da 014/042/043 inteiro. O que muda:

- `cobranca` ganha `origem` (`'contrato' | 'venda'`, default `'contrato'`) e `proposta_id`
  (nullable, FK `proposta_sdr`). Migração nova.
- `referenciaExterna` para a venda: `venda:{propostaId}:sinal` (hoje é
  `contrato:{id}:titulos:{ids}`). O `uniqueIndex('cobranca_referencia_aberta_uq')` já garante que
  pedir duas vezes não cria duas cobranças abertas — de graça.
- **`cobranca.contratoId` é `NOT NULL` e na venda ainda não existe contrato.** Ver Premissas.
- Valor: `RESERVA`-style, `VENDA_SINAL_CENTAVOS` no env (fixo) — ver Decisões.

### Servidor

`apps/server/src/venda/{fluxo,repo,worker,escalar}.ts` e tabela `venda`, no molde de
`apps/server/src/reserva/`. O pagamento confirmado (`eventos.ts`) dispara `FILA_ERP_VENDA`, que:

1. cria/garante a pessoa (`SetPessoa`) e o casal (`setcasal` + read-back);
2. chama `SetVenda` com o sinal já pago em `ContasFinanceirasAddUpdt` e o restante como parcelas;
3. grava `contratoId` em `venda` e em `erp_escrita` (`operacao='venda'`).

**Nada disso roda fora de worker, e nada roda sem pagamento confirmado.**

### Console

Tela `/vendas` (ou aba em `/leads`, ver Decisões) com o funil: proposta → sinal emitido → sinal pago
→ contrato criado → falhas. Drawer com o rastro da escrita no ERP, como `/reservas` faz hoje.

## Fora de escopo

- **015b** (aprovar/recusar proposta no console). Esta spec fecha o caminho **dentro da alçada**:
  quem pede abaixo do piso continua parando em `aguardando_aprovacao` como hoje. Fazer 015b junto
  dobraria a spec; ela segue como pré-requisito do ciclo completo e entra depois.
- **Assinatura de contrato** — jurídica antes de técnica, e fora até da 031.
- Parcelamento negociado na conversa (o SDR oferta à vista; o parcelamento do ERP é consequência do
  `SetVenda`, não da conversa), financiamento, indexadores, cartão recorrente.
- Prospecção ativa (031), cancelamento de venda com multa, `comercial.*` por HTTP (037).

## Premissas

1. **`setcasal` devolve `""`.** Confirmado no fixture: status 200, corpo string vazia. Não há id e
   **não há campo de referência externa** — a mesma armadilha da 038. A saída é o read-back por
   chave natural (`GetCasaisPorPeriodo` filtrando por data de cadastro + CPF), com `erp_escrita`
   garantindo que reprocessar não crie um segundo casal. Se o read-back não achar, a escrita fica
   pendente e sobe para o pg-boss — nunca "cria de novo por via das dúvidas".
2. **`setcasal` exige o que um lead de WhatsApp não tem**: `IdProfissao`, `RendaFamiliar`,
   `IdTipoResidencia`, `Veiculo1` (com modelo, ano, se é de luxo), `PerfilDeFerias`, endereço
   completo, `IdPromotorMarketing`, `IdLocalCaptacao`. Vão com default/zero, documentados num único
   lugar. **É pergunta ao fornecedor** se o TSE real aceita — e, como tudo nesta frente, vira
   premissa isolada para que a resposta custe uma função.
3. **O lead não tem CPF em lugar nenhum.** `lead` (schema.ts:340) tem `waId`, `nome`, `perfil` — e
   só. Mas `emitir.ts:83` **recusa emitir sem `contato.documento`**, o Asaas exige documento para
   criar cliente, `setcasal` exige `Cpf1` e `SetVenda` exige comprador. Por isso a etapa `dados`.
   O CPF sai do **texto cru pelo parser determinístico** (`extrairCpf` da 038, que já rejeita token
   de anonimização e valida DV), **nunca** da saída estruturada do modelo. Teste nomeado
   obrigatório, como na 038. O CPF coletado é gravado em `contato.documento` **sem**
   `clienteErpId` — assim o `emitir.ts` funciona sem alteração e o número continua sem vínculo,
   preservando a raia do SDR.
4. **`cobranca.contratoId` é `NOT NULL` e a venda não tem contrato ainda** — ele nasce depois do
   pagamento. Na 014 esse campo é usado só para (a) chavear o cliente no PSP
   (`pspClienteDe`/`referenciaCliente`) e (b) compor a descrição. A proposta é preenchê-lo com
   `lead:{leadId}` na venda de lead frio e com o contrato real no upgrade do cotista, e passar a
   filtrar por `origem` nas telas e em `pagosDoContrato`. **Alternativa** (mais limpa, mais cara):
   tornar a coluna nullable e mover a identificação do pagador para uma coluna própria. Decidir na
   execução e registrar no PR.
5. **A escrita comercial é irreversível do ponto de vista do cliente.** Contrato criado é contrato
   faturado. Nada é enviado sem pagamento confirmado pelo webhook, sob `erp_escrita`; valor abaixo
   do piso sem aprovação humana é recusado e auditado, nunca escrito.
6. **O card do PIX já está aprovado** (`cobranca_pix`, WABA `1137251935512196`): corpo com valor,
   vencimento e link; botão `ORDER_DETAILS` com o copia-e-cola. O texto diz "Sua cobrança de … está
   pronta", que serve para o sinal. Se o time preferir um texto de venda, é template novo e **passa
   por aprovação da Meta** — o que não cabe no prazo da demo. Assumir o existente.
7. **Fluxo novo precisa de teste entrando pelo turno completo.** A regressão consertada no PR #28
   existiu porque todos os testes da 038 chamavam `iniciarFluxo` direto, pulando o classificador —
   que é quem decide se o fluxo chega a existir. Esta spec trata isso como critério de aceite.

## Critérios de aceite

- **Lead frio**: número sem vínculo pede preço → qualifica → estoque real → oferta na tabela →
  aceita → informa nome e CPF → **recebe o card `cobranca_pix` com link e PIX do sinal** → paga no
  sandbox → webhook confirma → `setcasal` + `SetVenda` criam o contrato → o console mostra a venda
  com o `IdContrato`.
- **Cotista** (número com vínculo): "quero comprar outra cota" **não escala mais**; o fluxo começa
  com o contexto do contrato atual e **não pede CPF** (usa `contato.documento`).
- `obtercontratos?cpf=` do comprador passa a devolver o contrato novo, com parcelas.
- **Reprocessar o job não cria segundo casal nem segundo contrato** (`erp_escrita` +
  read-back).
- `200` com prosa inesperada de `SetVenda` vira erro, não sucesso.
- Pagamento não confirmado ⇒ **nada** é escrito no ERP; a venda fica visível como pendente.
- Pedido abaixo do piso continua parando em `aguardando_aprovacao` (comportamento atual).
- CPF do lead extraído do texto cru: teste provando que o token de anonimização **não** chega ao
  ERP nem ao PSP.
- **Teste do turno completo** (`/dev/inbound` → debounce → classificador → roteamento) para as duas
  raias, e teste de precedência entre cobrança, reserva e venda na raia do cotista.
- `pnpm lint && pnpm test && pnpm build` verdes.

## O que mudou em relação ao desenho da spec

1. **A referência da cobrança é a PROPOSTA, não a venda** (`venda:{propostaId}:sinal`). Com o id da
   venda — novo a cada chamada — o índice `cobranca_referencia_aberta_uq` nunca dispararia, e duas
   emissões virariam dois PIX para a mesma pessoa.
2. **O degrau da 015a ficou no CONTEXTO, não nas deps.** A máquina é pura: sem `sinalCentavos` o
   aceite volta a cair em `agendamento`. Descoberto quebrando dois testes da 015a.
3. **`fechamento` intercepta antes do guard de `nao_entendi`** — ver a nota em
   `04-modulos-entregues.md`. Sem isso o fluxo abandonava uma cobrança emitida depois de duas
   mensagens fora do roteiro.
4. **A etapa `dados` não passa pelo LLM** (`SEM_LLM` em `interpretar.ts`): o desenho original só
   dizia que o CPF viria do parser; na prática, o modelo nem é consultado ali.
5. **`IdProduto` virou env** (`VENDA_ID_PRODUTO`): o espelho não modela produto, e inventar um
   mapeamento tier→produto seria regra nossa. Pergunta aberta ao cliente.

## Fatiamento sugerido (é uma spec G)

- **045a — a conversa vira dinheiro.** Máquina (`dados`, `fechamento`), raia do cotista, cobrança do
  sinal com `origem='venda'`, card do PIX, confirmação pelo webhook, tela mínima. **Sem ERP.** Já é
  demonstrável: "o agente vendeu e o PIX chegou no WhatsApp".
- **045b — o dinheiro vira contrato.** Simulador (rotas comerciais), `ErpWriter.{criarPessoa,
  criarLead,criarVenda}`, worker `FILA_ERP_VENDA`, read-back, `IdContrato` no console.

A ordem importa: 045a entrega valor sozinha e 045b é encanamento invisível para quem assiste à
demo — a mesma lógica que a 035/036 seguiram.

## O que dá para demonstrar ao final

O ciclo comercial completo, sem humano no caminho feliz: **interesse → qualificação → oferta →
PIX no WhatsApp → pagamento → contrato de multipropriedade criado no ERP**. Junto com a cobrança
(014) e a reserva (038), fecha as três jornadas que sustentam a demo.

## Decisões a resolver (registrar a escolha na descrição do PR)

- **Valor do sinal**: fixo em `VENDA_SINAL_CENTAVOS`, percentual do valor negociado, ou por cliente
  no `client.yaml`? (A decisão do Renato foi "sinal"; falta a forma.)
- **`cobranca.contratoId`**: prefixo `lead:{id}` ou tornar a coluna nullable (Premissa 4).
- **Tela própria `/vendas` ou aba em `/leads`** — a 038 escolheu tela própria e funcionou bem.
- `IdPromotorMarketing` / `IdOrigemCasal` / `IdLocalCaptacao` para "originado pelo agente": que
  códigos o cliente usa? (Herdada da 039 — pergunta ao fornecedor.)
- O casal é criado na qualificação ou só no pagamento confirmado? (Esta spec propõe **só no
  pagamento**: menos lixo no ERP do cliente e uma escrita em vez de duas.)
