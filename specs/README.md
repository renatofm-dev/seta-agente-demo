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
| [035](035-tse-api-simulada.md) simulador da API do TSE | **Demo** | — |
| [036](036-erp-escrita-baixa.md) escrita no ERP e baixa real | **Demo** | 035 |
| [037](037-catalogo-http.md) catálogo por HTTP (`source: api`) | **Demo** | 035, 036 |
| [038](038-reserva-utilizacao.md) reserva de utilização pelo agente | **Demo** | 035, 036 |
| [039](039-sdr-escreve-no-erp.md) SDR escreve lead e venda no ERP | **Demo** | 036, 015b |
| [040](040-segunda-via-pdf.md) 2ª via de boleto em PDF | **Demo** | 036, 033 (fatia fina) |
| [041](041-tse-real-e-fim-da-conciliacao.md) TSE real e fim da conciliação | **Demo** | 037, ambiente do TSE |

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
  começar a 037.

```
035 ─► 036 ─┬─► 037 ─► 041
            ├─► 038
            ├─► 039 ◄─ 015b
            └─► 040 ◄─ 033

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
