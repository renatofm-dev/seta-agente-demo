# 024 — LGPD técnico: retenção, descarte, base legal do documento, exportação e eliminação

> **Pré-spec** (rascunho de 08/09/2026): ainda não executada. Depende de **D6** (política
> formal de uso, retenção e descarte; DPA com o provedor de IA). Item P-42, marco M4. A 016
> cuidou do que **sai**; esta cuida do que **fica**.

## Objetivo
O banco `app` guarda conversas, traces com o texto das mensagens, eventos e o CPF do
titular (`contato.documento`, que hoje vem de um YAML) por tempo indeterminado. A partir do
primeiro cliente real isso precisa de política: quanto tempo cada dado fica, como é
descartado, com que base legal o CPF é coletado, e como atender um pedido de exportação ou
eliminação de dados do titular.

## Reaproveita
- `db/schema.ts`: `mensagem`, `turno`, `trace_turno` (contexto e resposta em JSON),
  `evento_llm/guardrail/escalonamento/query`, `outbox`, `sinal_aprendizado`, `caso_eval`,
  `contato.documento`, `psp_cliente`.
- `seed-app.ts:44` (documento vem do `contatos.yaml`).
- `packages/anonimizacao` (`Cofre`, detectores) — reaproveitável para anonimizar em vez de
  apagar onde a estatística precisa sobreviver.
- pg-boss para o job de expurgo; `skills/sinais-job.ts` como molde de job diário.

## Escopo

### Política em código (`configs/<cliente>/client.yaml › retencao`)
```yaml
retencao:
  mensagens_dias: 365        # mensagem, turno, outbox
  traces_dias: 180           # trace_turno e evento_*: anonimizados aos 30, apagados aos 180
  sinais_dias: 365           # sinal_aprendizado; caso_eval anonimizado, mantido (evidência da skill)
  leads_dias: 180            # lead sem conversão
  cobrancas_dias: 1825       # cobranca/pagamento: 5 anos (obrigação fiscal), sem texto livre
```
Schema Zod em `client-config`; defaults conservadores; a política formal (D6) escolhe os
números.

### Job de expurgo (`apps/server/src/lgpd/expurgo.ts`)
- Diário (pg-boss): em duas fases — **anonimizar** (troca texto livre por tokens do
  `Cofre` sem chave de reversão; mantém contagens e datas para métricas) e **apagar** (delete
  em lote com limite por execução, respeitando FKs: eventos → trace → turno → mensagem).
- Registro em `evento_expurgo` (tabela, linhas, fase, `executado_em`) — prova de conformidade.
- `pnpm lgpd:expurgo --dry-run` mostra o que seria afetado.

### Documento do titular (CPF)
- `contato.documento` deixa de vir do YAML em produção: chega pelo cadastro do cliente
  (via view autorizada no espelho, 018, se o cliente permitir) ou é solicitado ao titular
  **no fluxo de pagamento** com aviso de finalidade (o PSP exige) e gravado com
  `documento_base_legal` e `documento_coletado_em`. Sem documento, o fluxo bloqueia e
  escala como hoje.
- `contatos.yaml` do piloto sem CPF; o seed de demo continua aceitando (dev).

### Direitos do titular (console › Configurações › LGPD, papel curador)
- **Exportar**: JSON com mensagens, tickets, cobranças e leads de um `wa_id`, gerado sob
  demanda e registrado.
- **Eliminar**: anonimiza imediatamente tudo do `wa_id` (mensagens, traces, lead) e apaga
  o vínculo; cobranças ficam anonimizadas pelo prazo fiscal; registro do pedido.
- **Opt-out** de mensagens proativas entra na 030; aqui só o registro do pedido.

### Documentação
- `docs/lgpd.md`: inventário de dados (tabela, campo, finalidade, base legal, retenção),
  fluxos de exportação e eliminação, o que sai para terceiros (Anthropic, Asaas, Meta) e o
  DPA de cada um.

## Fora de escopo
- Política jurídica em si e o DPA (D6, jurídico).
- Anonimização do que sai para a LLM (016, feita).
- Consentimento para marketing (030).

## Premissas
- Métricas e relatórios (010, 017) sobrevivem ao expurgo porque agregam contagens, não
  texto: a fase "anonimizar" mantém as linhas.
- Skills aprovadas já nascem tokenizadas (016: distiller com `destokenizar: false`).
- Cobrança e pagamento têm prazo fiscal próprio; não contêm texto livre.

## Critérios de aceite
- Com `mensagens_dias: 1` num banco de teste: após o job, mensagens de ontem sumiram,
  traces de ontem estão anonimizados, contagens do `/metricas` não mudaram.
- `--dry-run` lista sem apagar; `evento_expurgo` registra cada execução.
- Fluxo de pagamento sem documento pede o CPF com a finalidade, grava com base legal, e o
  PSP recebe; `contatos.yaml` sem `documento` não quebra o seed.
- Exportar devolve o JSON do titular; eliminar deixa zero linhas com o `wa_id` fora das
  cobranças anonimizadas; ambos registrados.
- `docs/lgpd.md` completo; `pnpm lint && pnpm test && pnpm build` verdes.
