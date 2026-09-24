# 046 — O contrato vira documento e o comprador assina

> **Pré-spec** (rascunho de 24/09/2026): ainda não executada. Fecha o ciclo comercial que a
> [045](045-venda-ponta-a-ponta.md) abriu — hoje o lead termina com um **número de contrato** e
> nada para assinar. Depende da **045** (entregue) e da **040** (entregue: envio de documento pela
> Cloud API, provado contra a Meta em 24/09). Tamanho **M**.
>
> **Ordem decidida pelo Renato em 24/09**: paga o sinal → contrato no ERP → **assina**. As outras
> duas ordens consideradas (assinar antes de pagar; assinatura destravando a reserva) estão em
> [Decisões](#decisões) com o motivo da recusa.

## Objetivo
Depois que o PIX do sinal cai, `apps/server/src/venda/worker.ts` escreve pessoa, casal e venda no
ERP e o TSE devolve `IdContrato`. O comprador recebe *"Pagamento confirmado e contrato registrado!
Seu contrato é o nº N"* — e é só isso. **Não existe documento**: uma varredura no repo não acha
nenhum PDF de contrato, e o `tse-sim` só sabe desenhar boleto (`apps/tse-sim/src/boleto-pdf.ts`).

Esta spec entrega o que falta entre "contrato registrado" e "contrato assinado": o documento nasce,
vai para assinatura, o comprador assina pelo celular, e o assinado volta para ele pelo WhatsApp.

## Reaproveita
- `apps/tse-sim/src/boleto-pdf.ts` (040) — desenho de PDF de uma página em Node, sem dependência
  nova. O contrato é o mesmo exercício com outro conteúdo.
- `apps/server/src/wa/outbox.ts` (040) — linha com **descritor de anexo**, worker que resolve os
  bytes na hora do envio e nunca os guarda. O contrato assinado entra pelo mesmo caminho do boleto.
- `packages/wa-meta/src/gateway.ts` (040) — `sendDocument` com upload em `/media`. **Exercitado
  contra a Meta de verdade em 24/09**: `wamid` real, status `entregue`, zero `%PDF` em log.
- `apps/server/src/pagamentos/eventos-routes.ts` (014/042) — o padrão de webhook de terceiro:
  rota com token, evento persistido antes de processar, idempotência por id do evento.
- `apps/server/src/venda/repo.ts` (045) — a tabela `venda` e seus estados; ganha os da assinatura.
- `docs/autentique-v2-api.json` — a coleção da API do Autentique v2, versionada em 24/09. É a
  **forma** que o provider simulado imita.

## Escopo
- **Port `AssinaturaProvider`** (`packages/assinatura`), com a interface que o Autentique v2 usa:
  `criarDocumento({ nome, pdf, signatarios }) → { id, links }` e `obter(id) → estado`. Interface no
  port, implementação fora — como `AIProvider` e `DbConnector`.
- **Duas implementações**: a **simulada** (default da demo) e a **Autentique real**, atrás da mesma
  interface, escolhida por env. A simulada vive no `tse-sim`: rota que aceita o PDF, devolve um
  `short_link` e uma página de assinatura que, ao ser usada, dispara o webhook de volta.
- **Documento do contrato**: rota nova no `tse-sim` que desenha o PDF a partir do contrato que a
  045 criou — partes, cota, valor, parcelas, foro. É o simulador fazendo o papel do ERP, como na
  2ª via.
- **Fluxo**: assim que a venda vira `confirmada`, o servidor gera o documento, cria a assinatura e
  manda **uma mensagem com o link** ("seu contrato está pronto para assinar"). Nada disso passa
  pelo modelo — é efeito do worker, como o boleto da 040.
- **Volta**: webhook de assinado → estado da venda para `assinada` → o **PDF assinado chega pelo
  WhatsApp** como documento, e o console mostra o clipe com o nome do arquivo.
- **Console**: a tela de Vendas ganha o estado da assinatura (`aguardando assinatura` / `assinada`,
  com data), e o link para reenviar.

## Fora de escopo
- **Devolver o assinado ao TSE.** Não se sabe se o ERP aceita anexo de contrato nem se algum status
  muda — é a pergunta ao fornecedor registrada abaixo. Quando a resposta vier, vira fatia própria.
- **Autentique em produção.** A implementação real entra atrás do port e pode ser exercitada no
  ambiente de testes deles, mas a demo roda no simulado (ver [Premissas](#premissas)).
- **Segundo signatário** (`IdComprador2` do `SetVenda`), procuração, testemunha. O `createSigner` do
  Autentique cobre isso; a demo tem um comprador só.
- **Certificado ICP-Brasil.** O Autentique assina por aceite eletrônico com trilha (IP, geo,
  horário) — é o que o fornecedor usa hoje, e é o que esta spec imita.
- Renegociar, cancelar ou distratar contrato assinado.

## Premissas
- **A API do TS Explorer não expõe assinatura.** Verificado na coleção de 90 rotas: as 8
  ocorrências de "Assinatura" são `TvAssinatura`/`FlgTvAssinatura`, campos do formulário de
  qualificação de lead. Quem conecta o Autentique é o sistema do fornecedor, fora da API.
- **Na demo, a assinatura é simulada** — e não por preguiça: o webhook do Autentique registra CPF,
  data de nascimento, IP e cidade de quem assina. Assinar de verdade numa demonstração cria
  registro de assinatura real, com dado real, de quem só está assistindo.
- **O contrato nasce depois do dinheiro** (045) e continua assim. A assinatura é o passo seguinte,
  não uma condição para o registro.
- O documento é **dado pessoal** (nome, CPF, valor): vale a regra da 040 — bytes atravessam, nada é
  guardado por nós, nada chega ao modelo.

## Critérios de aceite
- Venda `confirmada` ⇒ em segundos chega no WhatsApp *"seu contrato está pronto para assinar"* com
  o link, e a tela de Vendas mostra **aguardando assinatura**.
- Abrir o link, assinar ⇒ o webhook chega, a venda vira **assinada** com data, e o **PDF assinado
  chega como arquivo** no WhatsApp, com nome legível.
- O PDF do contrato traz as partes, a cota, o valor total, o sinal pago e a parcela de saldo — os
  mesmos números que foram para o `SetVenda`.
- Falha em qualquer ponto (documento, criação da assinatura, webhook que não chega) ⇒ **mensagem
  honesta + escalada**, nunca silêncio — a regra que a 040 aprendeu em campo.
- Reenviar o link não cria um segundo documento (chave idempotente, como o outbox).
- Nenhum byte de PDF em log, em prompt ou no banco.
- Trocar `ASSINATURA_PROVIDER=simulado|autentique` troca a implementação sem tocar no resto.
- `pnpm lint && pnpm test && pnpm build` verdes.

## Decisões
**A ordem, decidida em 24/09**: paga o sinal → contrato no ERP → assina.

| Alternativa | Por que não |
|---|---|
| assinar **antes** de pagar | exige gerar o documento de um contrato que ainda não existe no ERP — e a 045 decidiu não escrever nada antes do dinheiro entrar |
| assinatura **destrava a reserva** | amarra duas frentes (046 e 038) sem necessidade; a reserva já tem regra própria |

**Pergunta ao fornecedor** (nova — nenhuma das cinco do `docs/tse-api-setup.md §6` cobre):

> Como o TS Explorer conecta com o Autentique? É chamada de API do sistema (e existe endpoint para
> disparar e consultar), é o operador que envia pela tela, ou é integração server-side que não
> aparece na coleção? E o contrato assinado volta para o TSE — vira anexo do contrato, muda algum
> status?

A resposta decide se a implementação real entra pelo nosso lado ou se a assinatura continua sendo
passo do operador no sistema deles. **Não bloqueia esta spec**: o simulado roda sozinho, e o port
existe justamente para a resposta custar uma implementação, não um redesenho.

## O que dá para demonstrar ao final
O ato 7 do roteiro deixa de terminar em "contrato registrado" e passa a terminar com o comprador
**assinando pelo celular** e recebendo o contrato assinado no WhatsApp — do primeiro "quero uma
cota" à assinatura, sem ninguém digitar nada do outro lado.
