# 023 — WhatsApp comercial do cliente (WABA) e templates de utilidade

> **Pré-spec** (rascunho de 08/09/2026): ainda não executada. Depende de **D4** (iniciar a
> WABA na Meta — o prazo é deles) e **D7** (cobrança da Meta a partir de out/2026: quais
> modelos são "utility"). Item P-41, marco M4. Parte é espera externa, parte é código.

## Objetivo
Tudo roda com o número de teste da Meta (5 destinatários) e templates registrados nele. O
piloto precisa do número comercial do cliente, com a WABA aprovada, os templates da 013 e
da 014 submetidos na categoria certa (a Meta passa a cobrar "service" e recategoriza), e o
`WA_TEMPLATE_PAGAMENTO_CONFIRMADO` real para a confirmação fora da janela de 24 h.

## Reaproveita
- `docs/meta-setup.md` (app, número, token, webhook, diagnóstico).
- `packages/wa-meta/template.ts` (`createMetaTemplateApi`, `TemplateDefSchema`),
  `disparos-routes.ts` (`/modelos`, `/modelos/sincronizar`), Configurações › Canal.
- `apps/server/src/pagamentos/eventos.ts:225` (`WA_TEMPLATE_PAGAMENTO_CONFIRMADO`).
- `tools/dev-whatsapp.sh` (override de webhook só no número de teste — em produção o
  webhook é o do app).

## Escopo

### Processo (externo, com checklist versionado em `docs/meta-waba-<cliente>.md`)
- Verificação do negócio (Meta Business), número comercial (não pode estar em uso no
  WhatsApp comum), nome de exibição, WABA vinculada ao app, permissões do token de sistema
  (`whatsapp_business_messaging`, `whatsapp_business_management`), webhook do app apontando
  para a instalação (021), limites de conversa iniciais (250/1k/10k) e como subir de faixa.
- Templates a submeter: `lembrete_parcela` (013), `pagamento_confirmado` (014),
  `regularize` (013), e os do SDR fase 2 ficam para a 031. Categoria **utility** com a
  justificativa; a Meta pode recategorizar para marketing — `sincronizar` reflete.

### Código
- `env.ts`: `WA_PHONE_NUMBER_ID`, `WA_WABA_ID`, `WA_ACCESS_TOKEN` obrigatórios quando
  `NODE_ENV=production` e `modulos.atendimento` (hoje são opcionais em qualquer ambiente);
  `WA_TEMPLATE_PAGAMENTO_CONFIRMADO` obrigatório com `modulos.pagamentos`.
- Webhook de status de template (`message_template_status_update`) no `/webhook`: atualiza
  `modelo_mensagem.status_meta` sem depender do botão sincronizar (era fora de escopo na
  013; entra aqui porque em produção a aprovação chega assíncrona).
- Configurações › Canal: qualidade do número, limite diário e usados (Graph API
  `phone_numbers` e `analytics`), como no design; alerta amarelo quando a qualidade cai.
- Custo por modelo (D7): `modelo_mensagem.categoria` já existe; Métricas › Saúde do canal
  mostra mensagens por categoria no período (base para a projeção de custo).

### Migração do número
- O piloto pode começar no número de teste e migrar: conversas ficam (chave é `wa_id` do
  cliente, não o nosso número); o que muda é `WA_PHONE_NUMBER_ID` e o webhook. Runbook em
  `meta-setup.md`.

## Fora de escopo
- Templates com mídia, botões ou variável por destinatário (030).
- Múltiplos números por instalação.
- Prospecção ativa (031).

## Premissas
- O cliente é o dono da WABA; a SETA é parceira/desenvolvedora no app. Token de sistema do
  cliente vive no cofre (022).
- Enquanto a WABA não sai, o piloto roda com o número de teste (limite de 5 destinatários).

## Critérios de aceite
- Instalação em produção com número comercial: mensagem recebida e respondida; campanha
  com template aprovado entregue a um destinatário fora da janela; confirmação de
  pagamento fora da janela chega pelo template.
- Aprovação/rejeição de template chega pelo webhook e muda o status na tela sem clique.
- Boot em produção sem as envs obrigatórias falha com mensagem clara.
- Configurações › Canal mostra qualidade e limite; Métricas mostra mensagens por categoria.
- `pnpm lint && pnpm test && pnpm build` verdes.
