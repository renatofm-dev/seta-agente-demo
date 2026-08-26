# 000 — Escopo da POC

## Objetivo
Uma demo vendável, ao vivo, do produto de atendimento autônomo para a base TS Explorer:
WhatsApp real + dados de ERP mockados + human-in-the-loop + loop de skills com aprovação.
Não é o produto; é a prova da arquitetura dele.

## Roteiro da demo (o que a POC precisa sustentar, nada além)
- **Ato 1 — Autonomia com dado real de negócio**: contato pergunta "quais boletos tenho em
  aberto?" e "cadê meu pedido de ontem?"; agente responde com dados do ERP (mock) via
  catálogo de queries. Mostrar que ele admite não saber quando não há caminho de dado.
- **Ato 2 — Guardrail + HITL**: contato pede desconto; agente NÃO negocia, escala; painel
  mostra ticket aguardando; atendente assume, resolve, devolve ao bot.
- **Ato 3 — Auto-aperfeiçoamento**: botão "gerar propostas" roda o distiller sobre os sinais
  dos atos 1–2; curador aprova um skill no dashboard; repetir o cenário e mostrar a resposta
  melhor. Mostrar versionamento e rollback.
- **Ato 4 — Auditabilidade**: trace do turno (contexto → tools → verdicts → resposta) e
  página de métricas (resolução sem humano, escalonamentos, tokens).

## Cortes explícitos da POC (decididos; não rediscutir durante o dev)
- ERP real: fora. Postgres local simula o TS Explorer via views canônicas + seed realista (002).
- LLM local: fora do homelab (CX23 sem GPU). Provedor remoto via endpoint OpenAI-compatible
  atrás do port `AIProvider`. Dado é mockado ⇒ premissa de privacidade não é violada.
  Argumento de venda preservado: trocar para vLLM on-prem = trocar 2 variáveis de ambiente.
- Templates Meta: apenas tabela de registro + doc. Sem fluxo de submissão/aprovação real.
- Fluxo de verificação de vínculo contato↔cliente: pré-vinculado por seed.
- Memória semântica de longo prazo: fora. Só resumo rolante + fatos simples por contato.
- Masking LGPD: apenas o mecanismo por coluna no executor (com 1 exemplo); sem política completa.
- Multi-implantação, updater de frota, model registry, promoção de skill à frota: fora.
- Console: 4 telas (inbox, ticket, aprendizado, métricas). Sem gestão de templates/usuários.

## Premissas de ambiente
- Repo privado pessoal no GitHub (fora da org setaia), monorepo pnpm.
- Deploy: homelab Hetzner CX23 (2 vCPU / 4 GB / Ubuntu 24.04), Docker Compose + Caddy já
  existentes, wildcard `*.outerlab.com.br` ativo no Cloudflare. Subdomínio sugerido:
  `seta.outerlab.com.br`.
- WhatsApp: app Meta em modo dev com **número de teste** (até 5 destinatários verificados,
  grátis) — suficiente para demo. WABA real fica para depois da POC.

## Critério de sucesso
O roteiro completo roda ao vivo, do celular, em < 10 minutos, sem tocar em terminal.
Fallback de contingência: simulador web (004) executa o mesmo roteiro se a Meta falhar no dia.
