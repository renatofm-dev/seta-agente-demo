# 041 — Apontar para o TSE real e enterrar a conciliação

> **Pré-spec** (rascunho de 14/09/2026): ainda não executada. Última fatia da frente
> **demo ponta a ponta**. Depende da **037** e de uma decisão externa: **acesso a um ambiente da
> API do TSE** (homologação do fornecedor ou o ambiente do cliente-piloto) — hoje não existe.
> Tamanho **P/M**.

## Objetivo
As fatias 035–040 constroem e provam a integração contra um simulador. Esta aponta a mesma
plataforma para um TSE de verdade, prova que o contrato bate, e apaga a última camada de ficção do
sistema: `apps/server/src/pagamentos/conciliacao.ts`.

## Reaproveita
- Tudo de 035–037: o adapter não muda, o catálogo não muda, o teste de contrato vira o teste do
  real.
- [018](018-espelho-real.md) — o molde do teste `skipIf` contra ambiente externo
  (`apps/server/test/erp-contrato.integration.test.ts`) e a disciplina de "diferenças reais ficam
  dentro da camada de tradução, nunca no catálogo".
- `apps/tse-sim/contrato/indice.json` — as mesmas fixtures viram o oráculo do teste contra o real.

## Escopo
- `TSE_BASE_URL` apontando para o ambiente real; credencial no cofre (022), nunca em `.env`
  commitado.
- `apps/server/test/tse-contrato.integration.test.ts`: para cada rota usada, a resposta do real tem
  as mesmas chaves e tipos da fixture. `skipIf` sem a URL — no CI continua rodando contra o sim.
- **Resolver a premissa que a 037 deixou aberta:** `PainelDoCliente/*` resolve escopo pelo dono do
  token ou aceita `idContrato` de qualquer cotista? A resposta define se o caminho de leitura
  financeira por API sobrevive ou se migra para
  `Relatorios/ObterJsonDadosRelatorioComParametros`.
- `ERP_CONCILIACAO=off` por default.
- **Apagar** `apps/server/src/pagamentos/conciliacao.ts` e `apps/server/test/conciliacao.test.ts`;
  `createExecutorConciliado` sai de `apps/server/src/index.ts`; `pagosDoContrato` volta ao que era.
- `docs/dev/05-dados-e-integracoes.md` e `docs/dev/07-operacao-e-deploy.md`: a seção "TSE real"
  (rede, credencial, rotação, o que fazer quando a API cai).

## Fora de escopo
- O espelho SQL (018) — os dois caminhos coexistem: a API é o caminho da escrita e das leituras
  financeiras; as views são o caminho de `contrato.*`, `atendimento.*` e `comercial.*`, que não têm
  endpoint.
- Segunda vertical (028).

## Premissas
- O fornecedor ou o cliente fornece credencial de um ambiente que **não é produção com dinheiro
  real** — ou, se for produção, com um contrato de teste isolado e autorização escrita.
- Diferenças entre o sim e o real cabem no adapter; se alguma exigir mudança de contrato, o
  simulador muda junto, no mesmo PR (mesma disciplina da 018).

## Critérios de aceite
- `tse-contrato.integration.test.ts` verde contra o ambiente real, com a lista de divergências
  encontradas registrada no PR.
- Uma baixa real de ponta a ponta num contrato de teste, com read-back confirmando.
- `grep -r conciliacao apps packages` vazio.
- Boot loga `erp: tse <host>` e recusa subir com credencial de exemplo em produção.
- `pnpm lint && pnpm test && pnpm build` verdes.

## O que dá para demonstrar ao final
A plataforma conversando com o TS Explorer de verdade — e nenhuma linha de código fingindo nada.

## Decisões a resolver
- **Externa, e bloqueante:** existe homologação da API do TSE? Quem pede ao fornecedor? (No formato
  D1..D9 do [roadmap](../docs/roadmap.md).)
- O simulador continua existindo depois disso? (Recomendado: sim — é o que mantém o CI verde sem
  depender de terceiro.)
