# 042 — Asaas de verdade no sandbox: o PSP deixa de ser simulado

> **Executada em 15/09/2026** — PR #20. Primeira etapa da
> [frente de pagamentos](../docs/roadmap-pagamentos-whatsapp.md). Fecha a issue #11 do fork
> (`SETA-IA/seta-agente#77`). Não depende de decisão dos sócios — a D1 só governa produção
> ([027](027-asaas-producao.md)).

## Objetivo
A 014 entregou o fluxo de cobrança inteiro, mas nenhuma linha dele jamais falou com o Asaas:
sem `ASAAS_API_KEY`, `apps/server/src/index.ts:63-66` instancia o provider simulado, e é ele
que roda em todo teste e em toda demo. Esta spec troca o simulado pelo adapter real no
sandbox e corrige o que a primeira execução verdadeira expõe — porque um PSP de mentira
nunca reentrega evento, nunca devolve 401 e nunca demora.

## Reaproveita
- `packages/payment-provider/src/asaas.ts` (adapter completo: `garantirCliente`,
  `criarCobranca`, `obterPix`, `obterLinhaDigitavel`, `simularRecebimento`, `health`),
  `erros.ts` (`PspAuthError`, `PspBusinessError`, `PspUnavailableError`) e
  `ambienteDaUrl` (`asaas.ts:29-31`), que deriva sandbox × produção da base URL.
- `apps/server/src/pagamentos/`: `webhook-routes.ts` (token em tempo constante),
  `eventos.ts` (idempotência por id do evento, `marcarPaga`, `estornar`),
  `emitir.ts` (consulta por referência antes de criar), `conciliacao.ts`.
- `tools/dev-whatsapp.sh:184-223` — cria e atualiza o webhook `seta-dev` apontando para o
  túnel e o desliga no `Ctrl+C`.
- `docs/asaas-setup.md`, [ADR 0001](../docs/adr/0001-asaas-como-psp.md).
- `packages/payment-provider/test/asaas.test.ts` — o padrão de fake de `fetch` por
  `config.fetchFn`, que esta spec estende.

## Escopo

### Configuração (não é código)
- Conta sandbox própria; `ASAAS_API_KEY`, `ASAAS_WEBHOOK_TOKEN` (32–255 chars) e
  `ASAAS_WEBHOOK_EMAIL` no `.env`; `ASAAS_BASE_URL` fica no default de sandbox.
- CPF do titular em `configs/demo/contatos.yaml` (o Asaas exige `cpfCnpj`; sem ele a
  máquina de estados bloqueia por desenho e escala para humano).
- Webhook publicado pelo túnel com os sete eventos que `docs/asaas-setup.md:29-30` lista.

### Reprocesso de evento com erro
`eventos.ts:133-138` grava `processado_em` só quando não houve erro, e a reentrega do mesmo
evento cai no `onConflictDoNothing` por id (`eventos.ts:65`) sem gerar job novo. Resultado:
um evento que falhou fica parado para sempre, invisível fora da coluna `erro`.
- `GET /api/console/eventos-psp?pendente=true` lista os eventos com `processado_em` nulo.
- `POST /api/console/eventos-psp/:id/reprocessar` reenfileira o job, com guarda de
  concorrência (só se `processado_em` continuar nulo).
- Console › Cobranças mostra a contagem de pendentes e o botão de reprocesso no drawer de
  **Eventos do PSP**, que já existe em `cobrancas/page.tsx:205`.

### Fechar a brecha do simulador
`cobrancas-routes.ts:210` protege `simular-pagamento` só com `DEV_SIMULATOR`. Com chave
real, o botão chama `receiveInCash` de verdade — no sandbox é o comportamento desejado, em
produção seria uma baixa indevida. A rota passa a exigir também
`psp.ambiente !== 'producao'`, e o console esconde o botão pelo mesmo critério.

### Testes
- Integração do ciclo real com `fetchFn` fake respondendo como o sandbox: emitir → PIX →
  `receiveInCash` → webhook assinado → `pagamento` gravado → conciliação removendo o título.
- Evento que falha grava `erro` e não marca `processado_em`; o reprocesso o conclui; o
  reprocesso de evento já processado é no-op.
- `simular-pagamento` responde 404 quando `psp.ambiente === 'producao'`.

### Documentação
`docs/asaas-setup.md` ganha uma seção de diagnóstico com o que aparecer na primeira
execução real (`invalid_environment`, fila de webhook interrompida após 15 falhas, QR PIX
com validade até 23:59 em conta sem chave).

## O que a primeira execução real cobrou (15/09/2026)

O ciclo inteiro fechou contra o sandbox — cobrança `pay_yjpuup1ic7tn42tb` emitida pela
conversa do contrato 10002, `receiveInCash`, dois webhooks reais pelo túnel, baixa e
conciliação. Quatro coisas que o código não deixava óbvio:

1. **A chave do Asaas começa com `$`** e o `tools/dev-whatsapp.sh` sourceia o `.env` pelo
   shell (`set -a; . ./.env`). Sem aspas simples ela é expandida como variável indefinida
   e vira vazio: o server (Node, `--env-file`, sem expansão) funciona, mas o script pula o
   registro do webhook em silêncio. Corrigido no `.env.example` e no guia.
2. **O id de evento do Asaas contém `&`** (`evt_<hash>&<sequência>`), e o hash se repete
   entre pagamentos diferentes — só o sufixo distingue. A rota de reprocesso recebe esse id
   no path: `encodeURIComponent` no console, `z.string()` (nunca `z.uuid()`) no server, e
   jamais truncar no `&`.
3. **`pix_expira_em` veio `2027-09-18 23:59:59`**, não "23:59 do dia" como o guia afirmava —
   formato cru do Asaas, não ISO. O guia estava errado.
4. **Bug pré-existente no console**: `post()` mandava `content-type: application/json` sem
   corpo, e o Fastify recusa (`FST_ERR_CTP_EMPTY_JSON_BODY`). *Aprovar*, *Simular pagamento*
   e o *Reprocessar* novo devolviam 500. Os testes não pegavam porque o `app.inject` só põe
   o header quando há payload. Corrigido no cliente, e os `setErrorHandler` das rotas de
   pagamento pararam de mascarar 4xx do Fastify como 500.

A corrida do `PAYMENT_CREATED` chegando antes do commit de `emitir.ts` **não existe**: o
fallback por `externalReference` a cobre.

## Fora de escopo
- Produção, chave de produção, cofre de segredos, rotação de token — [027](027-asaas-producao.md)
  e [022](022-operacao-minima.md).
- Estorno ativo pela plataforma (hoje só reagimos ao evento; estorno é no painel do Asaas).
- Eventos do Asaas que não sejam os sete já assinados.
- Baixa no ERP — [036](036-erp-escrita-baixa.md).
- Qualquer mudança no template do WhatsApp — [043](043-template-pagamento-pix.md).

## Premissas
- A conta sandbox é da SETA, não do cliente; nenhum dado de cotista real entra nela.
- `PAGAMENTO_TETO_SEM_HITL_CENTAVOS` fica no default durante a validação; o rollout com
  teto zero é assunto da 027.
- O túnel do `dev-whatsapp.sh` é suficiente para o webhook em sandbox; webhook público
  estável é a [021](021-release-por-cliente.md).

## Critérios de aceite
1. O boot loga `psp: asaas-sandbox` e o aviso amarelo de PSP simulado some do console e da
   barra global.
2. Uma cobrança criada pela conversa aparece no painel do Asaas com a mesma
   `externalReference`; emitir a mesma cobrança duas vezes reaproveita a primeira e não cria
   duplicata.
3. `receiveInCash` dispara o webhook real; o evento é aceito com o token certo, recusado com
   401 sem efeito e reentregue sem processar duas vezes.
4. Depois de paga: `cobranca.status = 'paga'`, uma linha em `pagamento` por título, e
   `titulos_atraso` deixa de listar o título pago.
5. Um evento que falhou fica listado como pendente e é concluído pelo botão de reprocesso.
6. `simular-pagamento` responde 404 em ambiente de produção, mesmo com `DEV_SIMULATOR=true`.
7. `pnpm lint && pnpm test && pnpm build` verdes.
