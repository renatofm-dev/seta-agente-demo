# 020 — Base de conhecimento de produtos e cotas + glossário na persona

> **Pré-spec** (rascunho de 08/09/2026): ainda não executada. Depende de **D5** (dados do
> espelho) e da 019 (embeddings) para valer a pena; validação com o cliente na reunião
> semanal. Item P-38, marco M4.

## Objetivo
O agente sabe dizer "sua cota é Diamante Premium, Torre 1, UH 501, 2 períodos por ano" mas
não sabe explicar o que isso significa: o que diferencia OURO de DIAMANTE, PREMIUM de MASTER e
SPECIAL, como funcionam os modelos de uso (anual com 1 a 3 períodos, bienal), o que são os
pontos por tier, o que é UH. Quando o cotista pergunta, ele admite que não sabe. Esta spec
constrói a KB de produtos a partir do espelho, validada com o cliente, e ensina o agente a
decodificar o retorno de `meu_produto` e `minha_cota`.

## Reaproveita
- `kb/*.md` (5 documentos institucionais) e `pnpm kb:ingest` (008/P-32).
- `catalog/contrato/{meu_produto,minha_cota}.yaml`, `v_contrato_cota`, `v_cota_disponivel`
  (tier, modelo, períodos, pontos, capacidade).
- `packages/domain-erp` (`COTA_TIERS`, `CotaTier`).
- `configs/demo/client.yaml › persona` e `personaSdr` (o glossário entra ali).
- `packages/agent/src/prompt.ts` (montagem do contexto com KB e skills).

## Escopo

### Conteúdo (`kb/produtos/`)
- `categorias-e-tiers.md`: OURO × DIAMANTE; PREMIUM, MASTER, SPECIAL — o que muda (tamanho,
  capacidade, localização, pontos), com a fonte (tabela do espelho ou documento do cliente).
- `modelos-de-uso.md`: anual 1/2/3 períodos, bienal; alta e baixa temporada; como o
  período é escolhido (o que existe no ERP e o que é com a central).
- `pontos.md`: pontos por tier e por modelo, para que servem, o que não fazem (reserva não
  existe no sistema).
- `unidades.md`: blocos/torres, UH, capacidade; glossário curto.
- Cada documento com front-matter `fonte:` e `validado_em:` (data da reunião com o cliente).

### Persona e agente
- Glossário de 10 linhas na `persona` (e na `personaSdr`) para o agente usar os termos
  certos sem depender do retrieval.
- `prompt.ts`: instrução para, ao responder `meu_produto`/`minha_cota`, decodificar tier e
  modelo com a KB (uma frase) em vez de repetir o código.
- Skill seed `explicar-minha-cota.md` (009) com o padrão de resposta.

### Validação
- Roteiro de perguntas para a reunião com o cliente (`docs/kb-validacao-<cliente>.md`):
  10 perguntas de cotista com a resposta esperada; o cliente marca certo/errado; o que
  errar vira correção no `kb/`.

## Fora de escopo
- KB editável pela interface (032).
- Regras de reserva e calendário (não existem no ERP; o agente escala).
- Conteúdo comercial de venda (preço, promoções) — vem do catálogo `comercial/`, não da KB.

## Premissas
- O conteúdo sai do espelho e de documentos do cliente; nada é inventado. Onde não houver
  fonte, o documento diz "com a central" e o agente escala.
- Sem PII no repo: exemplos usam contratos sintéticos do seed.
- A KB de demo (`Mirante da Serra`) continua fictícia; a do piloto entra em
  `configs/<cliente>/kb/` (021 define o layout por cliente).

## Critérios de aceite
- "o que é DIAMANTE PREMIUM?" responde com a definição e cita o documento; "quantos pontos
  eu tenho e para que servem?" combina `minha_cota` com `pontos.md`.
- "posso reservar o Natal?" continua admitindo que não sabe e escalando.
- Os 4 documentos ingeridos com fonte e data; 10 perguntas do roteiro validadas pelo
  cliente (registro no PR).
- `agente.integration.test.ts` com um cenário de produto; `pnpm lint && pnpm test && pnpm
  build` verdes.
