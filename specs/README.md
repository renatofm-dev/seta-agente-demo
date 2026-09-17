# Specs da POC — Agente TS Explorer (SETA)

Conjunto de specs para desenvolver a POC de demonstração do produto de atendimento
autônomo sobre WhatsApp, rodando local (repo privado + homelab), fora da org setaia.

## Como usar
- Uma spec = uma sessão de Claude Code = um PR. A spec é a fonte de verdade da sessão.
- Ordem de execução respeitando o grafo abaixo. "Pronto" = critérios de aceite atendidos + testes passando.
- Stack travada (SDK SETA v1.0): TypeScript, Node 24 LTS, pnpm 10, Fastify 5, Zod, Drizzle,
  Postgres 17 + pgvector, pg-boss, Better Auth, pino, UUIDv7, LangGraph.js, Next.js + React 19,
  Tailwind 4, shadcn/ui, Vitest, Biome, dependency-cruiser. Nada fora disso sem ADR.
- Estrutura de pastas idêntica à arquitetura alvo do produto. A migração futura para a org setaia
  deve ser: trocar remote + subir CI — zero refactor.

## Grafo de dependências
```
001 fundacao
 ├─► 002 erp-mock ─► 003 catalogo-queries ─┐
 ├─► 004 gateway-whatsapp ─────────────────┼─► 005 runtime-agente ─► 006 guardrails
 ├─► 008 rag ──────────────────────────────┘            │
 └─► 007 crm-console-hitl ◄─────────────────────────────┤
                    └──────────► 009 skills-aprendizado ┘
010 observabilidade (transversal, depois de 005)
011 deploy-homelab (final)
```

## Sequência sugerida (solo, começando hoje)
1. **Hoje**: 001 + início de 002. Em paralelo (15 min de browser): criar app Meta com
   número de teste do WhatsApp e obter chave do provedor LLM.
2. 003 → 004 (com simulador) → 005: aqui já existe um agente conversável via simulador.
3. 007 (console mínimo) → 006 → 009 (o diferencial da demo).
4. 008 → 010 → 011 e ensaio do roteiro.

## Depois da POC (012 em diante)
| Spec | O que | Estado em 08/09/2026 |
|---|---|---|
| 012 | Domínio de multipropriedade (corrige a 002 a partir do espelho real) | ✅ `main` (#50) |
| 013 | Disparos de template para a carteira (reverte o corte da 004) | ✅ `main` (#59) |
| 014 | Compra e cobrança pelo WhatsApp (PSP Asaas, ADR 0001) | ✅ `main` (#59) — PSP em modo de teste |
| 015 / 015a | Agente SDR para lead frio: dados (#60) e núcleo (#64) | ✅ `main` — faltam 015b e 015c |
| 016 | Anonimização do que sai para a LLM | ✅ `main` (#61) |
| 017 | Relatório analítico de campanhas | ✅ `main` (#63) |
| 042 | Asaas de verdade no sandbox (PSP deixa de ser simulado) | ✅ `main` (#20) |
| 043 | Template de pagamento com PIX (order_details no WhatsApp) | ✅ `main` (#21) |
| 035 | Simulador da API do TS Explorer (`apps/tse-sim`) | ✅ `main` (#24) — 30 das 89 rotas da coleção |
| 036 | Escrita no ERP (`ErpWriter`) e baixa real do pagamento | ✅ `main` (#25) — a baixa chega ao TSE; conciliação vira compensação |
| 038 | Reserva de utilização de contrato pelo agente | ✅ 16/09/2026 — o agente reserva a semana e a utilização existe no ERP |
| 045 | Venda de ponta a ponta (sinal por PIX + contrato no ERP; absorve a 039) | ✅ 17/09/2026 — lead frio e cotista compram, e o contrato nasce no TSE |
| 040 | 2ª via de boleto em PDF pelo WhatsApp | ✅ 17/09/2026 — o boleto chega como arquivo, e o PDF não é armazenado em lugar nenhum |

A ordem, o calendário e as decisões pendentes estão em **[`docs/roadmap.md`](../docs/roadmap.md)**;
o mapa técnico do que cada spec entregou está em
**[`docs/dev/04-modulos-entregues.md`](../docs/dev/04-modulos-entregues.md)**.

## Pré-specs (o que ainda vamos desenvolver)

Escopo já desenhado, no mesmo formato, com o banner "Pré-spec" no topo e uma seção
"Reaproveita" apontando o código que já existe. Viram spec quando entram no sprint. A
numeração é a ordem de escrita, não de execução (015b e 015c executam antes das 018+; a 026
executa em M2, antes de M4).

| Pré-spec | Marco | Depende |
|---|---|---|
| [015b](015b-sdr-aprovacao-console.md) aprovar/recusar proposta no console | M1 | 015a |
| [015c](015c-sdr-guardrail-percentual.md) percentual por extenso na raia SDR | M1 | 015a |
| [026](026-backup-monitor-gitleaks.md) backup, monitor e gitleaks | M2 | — |
| [018](018-espelho-real.md) conexão ao espelho real | M4 | D5 |
| [019](019-embeddings-reais.md) embeddings reais | M4 | D8 |
| [020](020-kb-produtos-e-cotas.md) KB de produtos e cotas | M4 | D5, 019 |
| [021](021-release-por-cliente.md) release por cliente | M4 | D2 |
| [022](022-operacao-minima.md) operação mínima | M4 | 026 |
| [023](023-waba-do-cliente.md) WABA do cliente | M4 | D4, D7 |
| [024](024-lgpd-retencao.md) LGPD: retenção e descarte | M4 | D6 |
| [025](025-llm-on-prem.md) LLM dentro da rede do cliente | M4, só se D6 negar | D6 |
| [027](027-asaas-producao.md) Asaas em produção | M4, só se D1 sim | D1, 024 |
| [028](028-adaptador-seven.md) adaptador Seven (Winthor) | M5 | piloto |
| [029](029-copiloto-cobranca.md) copiloto de cobrança | M5 | piloto |
| [030](030-campanha-segmentada.md) campanha segmentada e opt-out | M5 | piloto |
| [031](031-sdr-fase-2.md) SDR fase 2 | M5 | 015b, 023 |
| [032](032-configuracao-pela-interface.md) configuração pela interface | M5 | 021 |
| [033](033-midia-no-whatsapp.md) mídia no WhatsApp | M5 | piloto |
| [034](034-multi-instancia.md) multi-instância | M5 | 021 |
| [037](037-catalogo-http.md) catálogo por HTTP (`source: api`) | **Demo** | ✅035, ✅036, **D10** |
| ~~[039](039-sdr-escreve-no-erp.md) SDR escreve lead e venda no ERP~~ | — | **absorvida pela ✅045** |
| [041](041-tse-real-e-fim-da-conciliacao.md) TSE real e fim da conciliação | **Demo** | 037, ambiente do TSE |
| [044](044-cobranca-proativa.md) cobrança proativa | **Pagamentos** | ✅042, ✅043 |


### A frente "demo ponta a ponta" (035–041)

Aberta em 14/09/2026: uma demo utilizável pela SETA, com pagamento em sandbox de gateway real, um
ambiente que simula o TSE pela **API** do fornecedor e o agente atendendo de ponta a ponta. A
decisão está no [ADR 0002](../docs/adr/0002-integracao-erp-por-api.md) e o contrato da API em
[`docs/tse-api-setup.md`](../docs/tse-api-setup.md).

Duas coisas que valem para quem for executar:

- **O catálogo híbrido (`source: sql | api`) é o estado final, não uma transição.**
  `contrato.minha_cota`, `contrato.status_cancelamento` e `atendimento.meu_chamado` **não têm
  endpoint** na coleção do fornecedor. A [018](018-espelho-real.md) segue necessária.
- **Premissa aberta e bloqueante da 037:** `PainelDoCliente/*` pode resolver escopo pelo dono do
  token, e o agente atende N cotistas com uma credencial. Resolver com o fornecedor antes de
  começar a 037. A **035 não resolveu — exercitou**: `TSE_SIM_PAINEL_ESCOPO=token|qualquer` roda
  os dois mundos, e o teste mostra que `utilizacaocontrato/obtercontratos?cpf=` ignora o escopo,
  que é a saída se a resposta vier ruim.

**035 e 036 foram entregues em 16/09/2026.** O simulador responde 30 das 89 rotas (placar em
`apps/tse-sim/test/pendentes.ts`, e o teste de contrato garante que só encolhe) e sobe com a demo
no homelab sem porta publicada; a baixa do pagamento **chega ao ERP de verdade** e a conciliação da
014 virou compensação do que ainda está em voo. **038, 039 e 040 estão destravadas.**
(A 039 foi absorvida pela **045**, entregue em 17/09 com o elo que faltava: o pagamento do sinal.)

**Nada disso esperou o fornecedor, e nem deveria:** a demo roda contra o simulador, que é nosso. As
cinco perguntas abertas (§6 do guia) bloqueiam a **041**, não a demo — cada uma virou premissa
escrita e isolada, para que a resposta custe uma função. A 036 acrescentou a mais importante delas:
**não existe endpoint de baixa para PIX ou boleto** na coleção.

**Se o objetivo é liberar a demo**, a fila muda de ordem: 036 e 037 são encanamento invisível (a
conversa responde igual antes e depois). O que APARECE na demo é a 038, a **045** (o lead do SDR
deixa de morrer na nossa tabela — paga o sinal por PIX e vira contrato no ERP) e a **040** (o
boleto em PDF chega no WhatsApp). **As três foram entregues** — 038 em 16/09, 045 e 040 em 17/09.
A demo ponta a ponta está fechada; o que sobra da frente é encanamento (037) e o TSE real (041).

**A 038 foi entregue em 16/09/2026** e trocou o ato mais honesto da demo pelo mais forte: o que era
*"o agente admite não saber reservar"* virou *"o agente reserva, e a utilização existe no ERP com o
nome do operador dele"*. A prova de honestidade não sumiu — mudou de âncora para troca de data e
calendário de temporada, que seguem com a central.

### A frente "pagamentos" (042–044)

Aberta em 15/09/2026: ligar o Asaas de verdade e mandar a cobrança pelo template que o cliente
já tem aprovado na WABA — card com o valor, link de pagamento no corpo e botão de copiar o código
PIX. O roadmap da frente está em
[`docs/roadmap-pagamentos-whatsapp.md`](../docs/roadmap-pagamentos-whatsapp.md).

A **042 e a 043 foram entregues em 15/09/2026**: o PSP fala com o sandbox de verdade, a
cobrança é paga por webhook real e conciliada, e o WhatsApp manda o template com o link no
corpo e o `order_details` no botão — validado no aparelho. Header de mídia continua sendo a
033; variável por destinatário e opt-out são a 044.

**A 043 começou descobrindo, e a descoberta mudou o escopo**: o template aprovado usa
`ORDER_DETAILS` (WhatsApp Pay BR), e o botão `COPY_CODE` era impossível — aceita 20
caracteres, o copia-e-cola do Asaas tem 180.

```
035✅ ─► 036✅ ┬─► 037 ─► 041
              ├─► 038✅
              ├─► 039 ◄─ 015b
              └─► 040 ◄─ 033

042✅ ─► 043✅ ─► 044        (042 ─► 027 ◄─ D1)

M0 ─► 015b ─► P-27          026 ─► 022
      015c
D5 ─► 018 ─► 020 ◄─ 019 ◄─ D8
D2 ─► 021      D4/D7 ─► 023      D6 ─► 024 ─► 027 ◄─ D1      D6(não) ─► 025
018 · 019 · 020 · 021 · 022 · 023 · 024 ─► piloto ─► 028–034
```

## Convenções
- Toda fronteira valida com Zod. IDs UUIDv7. Logs pino estruturados com traceId.
- Interfaces dos ports (`AIProvider`, `DbConnector`, `VectorStore`, `SkillRegistry`)
  ficam em packages próprios; implementações nunca vazam para quem consome o port.
- Commits convencionais. `.env` nunca commitado; `.env.example` sempre atualizado.
