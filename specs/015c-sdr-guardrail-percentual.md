# 015c — Guardrail da raia SDR: percentual por extenso e vocabulário proibido

> **Pré-spec** (rascunho de 08/09/2026): ainda não executada. Depende da 015a (no `main`).
> Item P-26 do roadmap, marco M1.

## Objetivo
`RE_PERCENTUAL` em `packages/guardrails/src/preco.ts:23` exige dígito
(`/\d+(?:[.,]\d+)?\s?(?:%|por\s?cento)/`). "Aplico três por cento" ou "dez porcento" passam
pelo guardrail de preço em qualquer raia — a lacuna está travada em teste
(`guardrails.test.ts`, caso "LACUNA"). Na raia do SDR isso importa: o agente de vendas
**nunca** pode falar em percentual, só em valor. Esta spec fecha a lacuna **na raia SDR** com
um hook próprio, sem tocar `preco.ts` (a raia do cotista continua exatamente como está, com o
seu teste intacto).

## Reaproveita
- `packages/guardrails/src/index.ts`: `GuardrailHooks`, `runBeforeReply` (rewrite substitui
  o draft e continua; block/escalate encerra) — o hook novo entra nesse pipeline.
- `apps/server/src/wa/turno-handler.ts:364`: o ponto onde a raia SDR é escolhida
  (`modulos.sdr && deps.sdr && clienteId === ''`); os hooks são montados ali por raia.
- `packages/sdr/src/render.ts`: textos determinísticos já respeitam o vocabulário; o teste
  de varredura existe em `packages/sdr/test/sdr.test.ts`.
- `guardrails.test.ts` "LACUNA": vira o teste positivo da raia SDR.

## Escopo

### `packages/guardrails/src/sdr-percentual.ts` (novo)
- `guardrailPercentualSdr`: hook `beforeReply` que detecta percentual em qualquer forma:
  dígitos com `%`/`por cento`/`porcento`, números por extenso de "um" a "cem" (`meio por
  cento`, `dois e meio por cento`, `dez porcento`), e o vocabulário proibido
  (`desconto|abatimento|cortesia|preço especial|condição especial|baixar o preço|faço por`).
  Verdict `rewrite` quando dá para trocar por uma frase neutra com o valor da tool
  (`valor_minimo_centavos`), senão `escalate` com trigger `desconto_acima_alcada` — o mesmo
  da 015a, para o console e o relatório não ganharem um motivo novo.
- Não lê nem altera `preco.ts`; exporta só o hook e a lista de vocabulário (compartilhada
  com o teste de varredura do `sdr`).

### Server
- `turno-handler.ts`: na montagem dos hooks da raia SDR, `[...hooksAtuais,
  guardrailPercentualSdr]`. Raia do cotista: lista inalterada.
- Verdict vai para o trace e vira `sinal_aprendizado` como qualquer outro (nada novo).

### Testes
- `guardrails.test.ts`: o caso "LACUNA" passa a ter duas versões: raia do cotista (mantém o
  comportamento atual, explicitamente) e raia SDR ("aplico três por cento" ⇒ escalate;
  "consigo por R$ 202.002,50" ⇒ allow).
- `sdr.integration.test.ts`: turno com `FakeAIProvider` respondendo um rascunho com
  percentual ⇒ o lead recebe o texto de transição e o trace tem o verdict.

## Fora de escopo
- Alterar `RE_PERCENTUAL` ou o comportamento da raia do cotista (fica para a lista de M5
  se a lacuna incomodar lá).
- Detectar percentual em mensagens **do lead** (é entrada, não saída; a máquina já trata
  "10%" como pedido de valor abaixo do piso).
- Vocabulário por cliente no `client.yaml` (032).

## Premissas
- Números por extenso até cem cobrem o caso real; "cento e vinte por cento" não é
  oferta plausível de um SDR e cai no `escalate` pelo "por cento".
- `rewrite` só é usado quando a frase neutra mantém a intenção sem inventar valor: o valor
  inserido vem sempre do resultado da tool `condicoes_cota` presente no turno; sem tool no
  turno, `escalate`.
- O hook é registrado só quando `modulos.sdr` está ligado; instalações sem SDR não mudam.

## Critérios de aceite
- "aplico três por cento", "dez porcento", "posso dar um desconto" em rascunho da raia SDR ⇒
  verdict `escalate` (ou `rewrite` com o piso, quando há tool no turno); raia do cotista com
  o mesmo rascunho ⇒ comportamento de hoje (teste explícito).
- Rascunho com "R$ 202.002,50" (piso da tool) ⇒ `allow`.
- `packages/sdr` continua sem nenhum texto com o vocabulário proibido (varredura).
- Trace do turno registra o verdict; `sinal_aprendizado` gravado; nenhum motivo de
  escalonamento novo aparece em Métricas.
- `pnpm lint && pnpm test && pnpm build` verdes.
