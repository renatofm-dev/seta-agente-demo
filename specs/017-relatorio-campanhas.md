# 017 — Relatório analítico de campanhas

## Objetivo
As campanhas da 013 mostram só o funil de entrega (enviadas → entregues → lidas → falhas), e
Métricas é uma tela ao vivo sem export. Esta spec fecha a pergunta que o gestor faz depois de
disparar: **a campanha converteu?** — cruzando cada campanha com o que aconteceu depois dela
(resposta, cobrança, pagamento, escalada) e com uma **meta de conversão**, em uma tela dentro
de Métricas com filtros por período, competência, modelo e janela de atribuição, insights em
prosa e export (CSV e impressão/PDF).

## Escopo

### Config e banco (`packages/client-config`, migração 0016)
- `client.yaml › campanhas.metaConversaoBps` (default 3000 = 30%): meta global de conversão,
  exposta em `/api/console/instalacao` e em Configurações › Regras (só leitura).
- `disparo.nome` (rótulo humano; ausente ⇒ nome do modelo) e `disparo.meta_conversao_bps`
  (meta própria; ausente ⇒ global). `POST /api/console/disparos` aceita os dois; a listagem e o
  detalhe devolvem.

### Servidor — `GET /api/console/relatorios/campanhas`
- Query Zod: `de`, `ate` (YYYY-MM-DD; default últimos 30 dias no fuso do cliente; intervalo
  ≤ 366 dias, senão 400), `competencia` (YYYY-MM), `modelo` (nome), `janelaDias` ∈ {7,15,30,60}
  (default 30).
- Uma consulta com CTEs: campanhas do período → destinatários × conversa → fatos por
  destinatário dentro da janela: `respondeu` (mensagem `in`), `cobranca` (cobrança na conversa),
  `pagou` (pagamento `confirmado`), `valor_pago`, `horas_ate_pagamento`, `escalou`
  (`evento_escalonamento`). Agregação por campanha + linha de totais (`GROUPING SETS`).
- Resposta: `filtros`, `campanhas[]` (funil completo, valor recuperado, escaladas, mediana de
  horas até o pagamento, `metaBps`, `conversaoBps`), `totais` (meta ponderada pelas entregas),
  `anterior` (mesma duração imediatamente antes de `de`, sem o filtro de competência) e
  `opcoes` (competências e modelos existentes, para os seletores).

### Console — Métricas › Relatório de campanhas (`/metricas?v=campanhas`)
- Abas em Métricas: Visão geral (tela atual) e Relatório de campanhas.
- Filtros na URL (link compartilhável): presets 7/30/90 dias, de/até, competência (ajusta o
  período para o mês), modelo, janela de atribuição.
- KPIs (conversão × meta com delta vs. anterior, valor recuperado, entregues, responderam);
  funil de 6 etapas (componente `Funil`, compartilhado com o detalhe da campanha); conversão
  por competência (barras + linha da meta); por modelo; tabela por campanha com situação contra
  a meta; insights gerados por função pura; card do período anterior.
- Export: CSV (linhas + total) e Imprimir/PDF (header, avisos e filtros saem da impressão;
  contêineres com rolagem viram fluxo).
- Wizard de nova campanha ganha `Nome da campanha` (passo 1) e `Meta de conversão (%)`
  (passo 3, pré-preenchida com a global; só é gravada se diferir dela). Lista e detalhe mostram
  nome e meta; detalhe linka para o relatório da competência.

## Fora de escopo
- Opt-outs e lista de supressão (não existe tabela; entra com a campanha segmentada).
- Agendamento, ritmo, segmentação por faixa de atraso.
- Relatórios de cobrança e de atendimento; envio automático por e-mail/Slack.
- Edição da meta pela interface (fase de Configurações).
- Competência financeira (mês de vencimento da parcela): aqui competência é o mês de envio.

## Premissas (decisões do Renato, 2026-09-08)
- **Conversão = pagas ÷ entregues** (entregue ou lido), em bps.
- **Meta**: global no `client.yaml` + override por campanha no wizard.
- **Competência = mês de envio** da campanha, no fuso `America/Sao_Paulo`.
- **Janela de atribuição** default 30 dias (7/15/30/60 na tela).
- **A última campanha que alcançou o número leva o crédito**: um evento não é atribuído a uma
  campanha se outra campanha (efetivamente enviada) chegou ao mesmo número entre o envio e o
  evento.
- Insights, agrupamentos por modelo/competência e CSV são calculados no cliente a partir das
  linhas do servidor (funções puras com teste unitário).

## Critérios de aceite
- Campanha para 3 contatos com 2 entregues (1 lida), 1 falha, 2 respostas, 1 cobrança e 1
  pagamento simulado ⇒ o relatório devolve `entregues 2 · responderam 2 · cobrancas 1 · pagas 1 ·
  conversaoBps 5000`, valor recuperado igual ao da cobrança e meta 3000 (acima).
- Pagamento 40 dias após o envio: não conta com janela 30, conta com janela 60.
- Duas campanhas ao mesmo número: o pagamento posterior à segunda é atribuído só a ela.
- `nome` e `metaConversaoBps` do `POST /disparos` aparecem na listagem e no relatório; sem meta
  própria vale a global.
- Filtro de competência sem campanhas devolve totais zerados; `de` depois de `ate` e intervalo
  > 366 dias respondem 400; `anterior` e `opcoes` vêm preenchidos.
- Tela renderiza funil, KPIs, tabela e insights; CSV e impressão saem com os filtros aplicados.
- `pnpm lint && pnpm test && pnpm build` verdes.
