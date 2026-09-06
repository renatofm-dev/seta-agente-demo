# Roadmap — Plataforma de Atendimento (seta-agente → seta-atendimento)

**Data:** 6 de setembro de 2026
**Para:** sócios da SETA (Parte 1) e time de desenvolvimento (Parte 2)
**Preparado por:** Renato Martins
**Substitui:** a seção "Próximos passos até produção" do `status-do-projeto.md` de 31/08
**Integra:** o backlog da empresa (`BACKLOG_2026-09-02_v2.md`, Project "SETA — Backlog")

> Este documento tem duas partes. A **Parte 1** é para quem decide: onde estamos, quais
> marcos vêm pela frente, o que cada um destrava e quais decisões só os sócios podem
> tomar. A **Parte 2** é para quem constrói: os mesmos marcos abertos em itens com
> tamanho, dono, dependência e critério de pronto, no formato do backlog da empresa.
> Um glossário curto fecha a Parte 1.

---

# Parte 1 — Para os sócios

## Em uma tela

O protótipo está **mais adiantado do que o relatório de 31/08 dizia** — e, ao mesmo
tempo, **menos publicado**. As três melhorias do teste real, a troca para o domínio de
multipropriedade, o disparo de mensagens de template e a cobrança pelo WhatsApp com
link de pagamento **estão prontas e testadas** (272 testes automáticos, esteira verde).
Mas nada disso chegou ao servidor: ele ainda roda a versão de agosto, e o histórico
principal do código ficou parado por um erro de ordem na integração dos trabalhos —
já identificado e com a correção pronta para aprovação.

O que vem a seguir se organiza em **cinco marcos**. Os dois primeiros cabem em setembro;
o piloto com um cliente real pode começar na **segunda quinzena de outubro**, desde que
as decisões listadas na seção "Decisões" sejam tomadas até o fim de setembro.

| Marco | Quando | Em uma frase |
|---|---|---|
| **M0 — Publicar o que está pronto** | até 13/09 | O servidor passa a rodar a versão atual; o repositório vai para a organização |
| **M1 — Agente de vendas (SDR)** | até 20/09 | Quem chega perguntando preço é atendido, recebe oferta dentro de uma alçada e é agendado com o comercial |
| **M2 — Blindagem** | até 27/09 | Fecha os buracos conhecidos antes de expor o sistema a tráfego real |
| **M3 — Decisões e pré-requisitos** | até 04/10 | Cliente-piloto, WhatsApp comercial, acesso ao banco, LGPD, pagamentos — nada disso é código |
| **M4 — Pronto para o piloto** | até 18/10 | Conectado ao banco real do cliente, com operação mínima e versão identificada |
| **M5 — Depois do piloto** | sem data | Segunda vertical (Seven), copiloto de cobrança, configuração pela interface |

**Uma mudança de rumo registrada aqui:** o relatório de 31/08 previa, como estágio 3,
"uma plataforma que atende vários resorts ao mesmo tempo". O briefing da empresa de
02/09 corrige isso: parte dos clientes **não permite dado saindo da rede deles**, então a
plataforma será **instalada isolada por cliente** — uma base de código, muitas
instalações. Isso é mais simples de construir e muda o que precisamos: não é
multi-cliente na mesma instalação, é **versionar e instalar bem** (item P-18 do backlog).

## Onde estamos, de verdade

A revisão de 06/09 cruzou três fontes: as 16 especificações escritas, o código como
ele está e o GitHub (issues, PRs, histórico). Resultado:

| O que | Situação | Observação |
|---|---|---|
| Módulos planejados (specs 000–014) | ✅ 15 de 15 construídos e testados | 272 testes automáticos, esteira verde |
| Agente de vendas (spec 015) | 🟡 base de dados pronta; o agente em si, não | tabela de preço, estoque à venda e a regra da alçada de 3% já provada em teste |
| Código integrado no histórico principal | 🔴 parado em 01/09 | quatro entregas ficaram "penduradas" por ordem errada de integração; a correção (PR #59) está pronta e com esteira verde |
| Servidor de demonstração | 🔴 versão de agosto | nada de setembro foi publicado |
| Versão identificada (release) | ❌ nenhuma | não existe numeração de versão ainda |
| Segurança para exposição pública | ⚠️ três chaves com valor de desenvolvimento aceito em produção; senhas do banco escritas no arquivo de instalação | tudo corrigível em menos de um dia |
| Busca na base de conhecimento | ⚠️ só por palavras, sem busca semântica | o fornecedor de IA atual não oferece o componente; escolher outro é decisão (D8) |
| Dados de cotistas e o fornecedor de IA | ⚠️ nome e CPF nunca saem; mas contrato, valores e situação de pagamento **vão para o fornecedor de IA nos EUA** | precisa de contrato de tratamento de dados **ou** IA dentro da rede do cliente (D6) |
| Backlog da empresa | ⚠️ lista como pendentes 5 itens que já estão prontos | corrigido pela reconciliação da Parte 2 |

Em números: o relatório de 31/08 falava em 11 módulos e ~200 testes. Hoje são **15
especificações entregues, 33 tabelas, 41 rotas, 7 filas de trabalho, 272 testes**.
O que faltava — publicar — continua faltando, e é o M0.

## Os marcos

### M0 — Publicar o que está pronto (até 13/09)

**O que fica de pé:** o histórico principal integra tudo que foi feito; o servidor roda a
versão atual; o repositório sai da conta pessoal e entra na organização SETA-IA como
`seta-atendimento`; o backlog da empresa reflete o que está pronto.

**O que destrava:** o protótipo volta a ser demonstrável **sem depender do computador do
Renato**, e o ensaio do roteiro com os sócios comerciais (já no backlog) pode acontecer.

**Custo:** menos de um dia de trabalho. É quase todo aprovação e operação, não código.

### M1 — Agente de vendas para quem chega sem cadastro (até 20/09)

Hoje, um número desconhecido que escreve "quanto custa uma cota?" recebe uma resposta
escrita para quem **já é cotista** ("posso ajudar com o seu contrato atual") e é passado
para o comercial sem que ninguém pergunte quem é a pessoa. É um vazio.

**O que fica de pé:** o agente qualifica quem chega (quantas pessoas, época de uso),
apresenta o que existe disponível, faz uma oferta com **até 3% de desconto** sobre o
valor de tabela da cota, e agenda com o comercial. Acima de 3%, um humano valida antes.

**Por que é seguro:** a inteligência artificial **nunca calcula o valor**. O sistema
calcula, grava a oferta antes de enviar, e a IA só redige. A trava de preço que já
existe impede qualquer valor fora do autorizado — isso foi provado em teste, sem
alterar a trava.

**O que destrava:** um argumento comercial novo para a base TS Explorer — venda
autônoma, não só atendimento.

### M2 — Blindagem para exposição (até 27/09)

**O que fica de pé:** o sistema recusa subir em produção com chaves de desenvolvimento;
senhas fora dos arquivos de instalação; a imagem só é publicada se a esteira estiver
verde; backup automático do banco com restauração testada; monitor de disponibilidade
avisando no Slack se o agente ficar mudo.

**O que destrava:** ficar exposto na internet com tráfego real sem os buracos que a
revisão encontrou. São itens pequenos e bem definidos — bons para o dev pleno entrar
no repositório.

### M3 — Decisões e pré-requisitos (em paralelo, até 04/10)

Nada aqui é código. São nove decisões ou providências, cada uma com dono, prazo e
consequência de não ser tomada. Estão na seção seguinte.

### M4 — Pronto para o piloto (até 18/10)

**O que fica de pé:** conectado ao **espelho do banco real do cliente** (não ao sistema
vivo — menor risco, e o espelho já existe); base de conhecimento sobre os produtos e as
cotas validada com o cliente; busca semântica funcionando; cada instalação com versão
identificada e configuração do cliente fora da imagem; operação mínima (proteção contra
sobrecarga, alertas, cofre de segredos, política de retenção de dados); WhatsApp
comercial do cliente.

**O que destrava:** o piloto pode começar na semana de **19/10**.

### M5 — Depois do piloto (sem data)

Adaptador para o ERP Winthor (linha Seven); copiloto de cobrança para o time do Bali,
construído sobre a cobrança que já existe; prospecção ativa pelo agente de vendas;
configuração de cliente, base de conhecimento e catálogo pela interface; envio de
fotos, áudios e documentos.

## Decisões que só os sócios ou o CTO destravam

| # | Decisão | Quem | Até | Se não for tomada |
|---|---|---|---|---|
| **D1** | Pagamentos entra no piloto? Qual o teto sem aprovação humana? Aceitamos o Asaas como fornecedor a mais? (as três perguntas do relatório de 31/08) | Sócios | 27/09 | O piloto sai sem cobrança real; a funcionalidade fica em modo simulado |
| **D2** | Como versionamos e instalamos por cliente (registro de decisão P-18): número de versão por entrega, imagem por versão, configuração do cliente fora da imagem | CTO | 27/09 | Cada instalação vira improviso; sem como saber que versão roda onde |
| **D3** | Qual é o cliente-piloto. **Premissa deste roadmap: Bali Park** — o espelho do banco já existe, há reunião semanal de validação, e o acesso já respeita LGPD | Sócios | 20/09 | O M4 não tem alvo |
| **D4** | Conta comercial de WhatsApp (WABA) do piloto — **iniciar o processo na Meta já em 07/09**, porque o prazo é deles | Cliente + SETA | 11/10 | O piloto fica limitado a 5 números de teste |
| **D5** | Acesso da plataforma ao espelho do banco do piloto (servidor, usuário só-leitura, rede) | CTO + cliente | 27/09 | A conexão ao banco real não começa |
| **D6** | LGPD: política formal de uso, retenção e descarte; **contrato de tratamento de dados com o fornecedor de IA**; e a pergunta que define o piloto: **o dado do cotista, mesmo sem nome e CPF, pode sair para um fornecedor nos EUA?** | Sócios + jurídico | 27/09 | Se a resposta for "não", a IA precisa rodar dentro da rede do cliente — o piloto atrasa pelo menos duas semanas e exige servidor com placa de vídeo |
| **D7** | A Meta passa a cobrar mensagens de serviço em **outubro de 2026**: quais modelos viram "utilidade", custo projetado por cliente (já no backlog como P-20, prazo 30/09) | CTO | 30/09 | Custo surpresa em outubro nas duas linhas de produto |
| **D8** | Fornecedor de busca semântica (embeddings) — o atual não oferece | CTO | 20/09 | A base de conhecimento continua buscando só por palavras; piora conforme cresce |
| **D9** | **Quem constrói a plataforma.** Premissa: as especificações continuam com o CTO usando Claude Code (foi assim que 15 saíram em ~8 dias); o dev pleno entra pelos itens de infraestrutura do M2 | CTO | 13/09 | O calendário dos marcos muda |

## Riscos que mudam o roadmap

| Risco | Efeito | Encaminhamento |
|---|---|---|
| **D6 negativo** (dado não pode sair) | M4 ganha um item grande (IA dentro da rede) e o piloto desliza ≥ 2 semanas | Decidir cedo; o sistema já foi construído para trocar de fornecedor sem reescrever |
| **Prazo da Meta** para a conta comercial | Fora do nosso controle | Iniciar em 07/09; o piloto pode começar com o número de teste e migrar |
| **Capacidade** | A plataforma foi construída pelo CTO com Claude Code; o backlog da empresa tira o CTO da capacidade planejada dos devs | D9 explicita a premissa; se mudar, o calendário muda junto |
| **Servidor de demonstração é pequeno** (2 vCPU / 4 GB) | Suporta o protótipo e um piloto controlado; não suporta volume | Dimensionar junto com D3; a instalação por cliente (D2) resolve estruturalmente |
| **Integração fora de ordem** (o que parou o histórico) | Pode se repetir em qualquer trabalho empilhado | Regra adotada: verificar por conteúdo, não pelo status do PR; documentada na memória do projeto |

## Glossário

| Termo | O que significa aqui |
|---|---|
| **SDR** | Agente de pré-venda: qualifica quem chega, apresenta, oferta e agenda com o comercial |
| **Alçada** | O limite de desconto que o agente pode oferecer sozinho (3%); acima disso, um humano valida |
| **Espelho** | Cópia sincronizada do banco do cliente, só-leitura, com nome e CPF inacessíveis |
| **WABA** | Conta comercial de WhatsApp aprovada pela Meta; sem ela, só 5 números de teste |
| **Embeddings / busca semântica** | Busca por significado, não só por palavras — "distrato" encontra "cancelamento" |
| **Release / versão** | Uma entrega identificada por número, para saber exatamente o que roda em cada cliente |
| **P-xx, D-x, M-x** | Item do backlog da empresa, decisão deste roadmap, marco deste roadmap |

---

# Parte 2 — Para o time

## Como ler

- **Calendário:** sprints semanais, segunda a domingo. **S4 = 07–13/09 · S5 = 14–20/09 ·
  S6 = 21–27/09 · S7 = 28/09–04/10 · S8 = 05–11/10 · S9 = 12–18/10 · S10 = 19–25/10.**
  Datas ordenam; não são compromisso (backlog V2 §2.2).
- **IDs `P-12` a `P-20`** são do backlog V2 e já existem como issue. **IDs `P-21` a `P-43`**
  são provisórios até a triagem de segunda no Project 6 — viram número de issue lá.
- **Campos** seguem o modelo V2: Tipo · Produto · Prio · Tamanho (P ≤ ½ dia, M ≤ 2 dias,
  G ≤ 1 sprint) · Dono (Dev, Gestão, Externo). Tudo aqui é `Produto: Plataforma`, salvo
  indicação.
- **Specs `016+`** seguem `specs/README.md`: 1 spec = 1 sessão = 1 PR, com critérios de
  aceite e `pnpm lint && pnpm test && pnpm build` verdes.
- **Aceite** em até 3 linhas, no padrão V2 §2.5: o que se observa quando acabou.

## Diagnóstico técnico (o que a revisão de 06/09 encontrou)

| Área | Estado | Evidência |
|---|---|---|
| Specs 000–014 | ✅ 272 testes, lint/build verdes, CI verde no #59 | auditoria de código |
| Spec 015 (SDR) | 🟡 `tabelapreco`, `v_cota_disponivel`, 11 testes de alçada; `packages/sdr` não existe | PR #60 |
| `main` | 🔴 parado na 012 | `git cat-file -e origin/main:apps/server/src/disparos-routes.ts` → não |
| PRs #51/#52/#53/#55 | 🔴 mergeados em branches base já absorvidas; conteúdo nunca chegou no `main` | `gh pr view N --json baseRefName,mergedAt` |
| Homelab | 🔴 versão de agosto | status-do-projeto 31/08 |
| Releases | ❌ nenhuma tag; `release.yml` publica imagem **sem `needs: ci`** | `.github/workflows/` |
| Env em produção | ⚠️ `WA_VERIFY_TOKEN`, `WA_APP_SECRET`, `BETTER_AUTH_SECRET` com default de dev, sem validação por `NODE_ENV` | `apps/server/src/env.ts` |
| `compose.prod.yml` | ⚠️ `DATABASE_URL`/`ERP_DATABASE_URL` hardcodam `app_owner_dev`/`erp_ro_dev` | `infra/compose.prod.yml` |
| `.env.example` | ⚠️ faltam `CATALOG_DIR`, `CONTATOS_PATH`, `SKILLS_SEED_DIR`, `AGENT_TURNOS_CONCORRENTES`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` | diff × `env.ts` |
| Embeddings | ⚠️ `EMBEDDING_MODEL` vazio (Anthropic sem `/embeddings`); `AIProvider` usa uma base URL para chat e embed | `openai-compatible.ts:107` |
| Guardrail de preço | ⚠️ `RE_PERCENTUAL` exige dígito — "três por cento" passa em qualquer contexto; travado em teste | `guardrails.test.ts` "LACUNA" |
| LGPD / saída de dado | ⚠️ `v_cotista` pseudonimiza; contrato, valores e inadimplência vão para a Anthropic | spec 012, briefing §9 |
| Debounce | ⚠️ serialização por conversa em `Map` em memória → processo único | `debounce.ts:77` (#33) |
| Índice HNSW | ⚠️ criado em runtime por `ensureIndex()`, não em migração | `pgvector-store.ts` |
| `kb:ingest` | ⚠️ não remove documento cujo arquivo sumiu (3 docs de e-commerce sobraram até 03/09) | `kb-ingest.ts` |
| Console | ⚠️ 10 testes para ~2.800 linhas de UI; `/` é placeholder da 007 | `apps/console/app/page.tsx` |
| Backup | ⚠️ manual; nunca automatizado nem restaurado | `docs/deploy-homelab.md` |
| Comentários desatualizados | `outbox.ts:170` "POC sem template" (013 reverteu); `types.ts:61` "stub [] até lá"; `turnoHandlerLog` exportado sem uso | grep "POC\|stub" |
| Issues | #45, #46, #47, #54 abertas com código pronto; #48 fecha via #59 | `gh issue list` |

## M0 — Publicar o que está pronto (S4)

| ID | Item | Tam | Dono | Depende | Aceite |
|---|---|---|---|---|---|
| — | Mergear **#59** (`spec/014 → main`); depois **#60** (re-aponta para `main` sozinho) | P | Gestão | CI verde (já) | `main` contém `apps/server/src/disparos-routes.ts` e `packages/cobranca/` |
| — | Fechar #45, #46, #47, #54 com comentário "entregue no #59"; #48 fecha pelo `Closes` | P | Gestão | merge #59 | Project 6: os 5 em Concluído |
| **P-12** (#56) | Transferir para `SETA-IA/seta-atendimento`: `gitleaks git` no histórico **antes**; "Transfer ownership" (não re-push); CODEOWNERS + team `devs` no mesmo dia (backlog V2 §8) | P | Gestão | — | repo na org, CI verde, issues e PRs preservados, remote redirecionado |
| **P-21** | Deploy no homelab: `release.yml` gera imagens do `main` novo → `infra/deploy.sh` → `demo-seed.sh` | P | Dev | merge #59; P-12 (GHCR da org) | `/healthz` responde com a versão nova; Ato 5 (cobrança) roda do celular |
| **P-22** | Tag `v0.1.0` = "POC completa (000–014)" como baseline; esquema definitivo vem de D2 | P | Dev | P-21 | tag no repo; imagem `:v0.1.0` no GHCR |
| **P-23** | `docs/status-do-projeto.md` entra no repo com a §8 apontando para este roadmap | P | Gestão | este PR | no `main` |
| **V-05** (seta-gestao#7) | Ensaio do roteiro com os sócios comerciais | P | Gestão | P-21 | 5 atos em < 10 min, do celular |

## M1 — SDR completo (S4–S5) — spec 015, fatiada em 3

`specs/015-sdr-lead-frio.md` está escrita; o PR #60 entregou a base de dados
(`tabelapreco` 6×4, `v_cota_disponivel`, `GRANT` para `erp_ro`, 11 testes que provam a alçada
contra o `guardrailPreco` **sem alterá-lo**).

| ID | Item | Tam | Dono | Depende | Aceite |
|---|---|---|---|---|---|
| **P-24** (015a) | **Núcleo.** `packages/sdr`: máquina `qualificacao → apresentacao → oferta → agendamento → encerrado`, parser determinístico, `interpretarResposta` (LLM só como fallback), piso em bps com aritmética inteira. Migração 0015: `lead`, `fluxo_sdr`, `proposta_sdr` (gravada **antes** do envio). `catalog/comercial/estoque_disponivel.yaml` + `condicoes_cota.yaml` com `price_source: true` (campo já existe em `CatalogEntrySchema:55`, nunca usado) devolvendo `valor_tabela_centavos` **e** `valor_minimo_centavos`; piso via param `source: session` (conferir `KNOWN_SESSION_PARAMS`). `buildToolSpecs` filtra por escopo da tool, não por vínculo (`tools.ts:38`). `comprar_cota` **sem vínculo** inicia o fluxo (`turno-handler.ts:405`, mesma forma de `pagar → fluxo` em `:400`); com vínculo, mantém escalada. Trigger `desconto_acima_alcada` + ticket com a proposta. `modulos.sdr`, `personaSdr`, env `SDR_DESCONTO_MAX_BPS=300`, `SDR_FLUXO_EXPIRA_MIN`, `SDR_MAX_PROPOSTAS_DIA` | G → fatiar se passar de 1 sprint | CTO | #60 mergeado | Número sem vínculo entra no fluxo e o trace sai com `tools_expostas` não-nulo; número com vínculo continua escalando `interesse_compra`; oferta na tabela e no piso passam o guardrail; abaixo do piso escala; testes no molde de `cobranca.integration.test.ts` |
| **P-25** (015b) | **Console Leads:** lista, perfil, propostas; aprovar/recusar `desconto_acima_alcada` (molde: `cobrancas/page.tsx` + `cobrancas-routes.ts`) | M | CTO | 015a | Humano aprova/recusa proposta acima da alçada pelo console e o lead recebe a resposta |
| **P-26** (015c) | **Guardrail da raia SDR:** fecha a lacuna do percentual por extenso **sem tocar `preco.ts`** — hook próprio registrado só com `modulos.sdr`; inverte o teste "LACUNA" na raia SDR. Vocabulário proibido nos templates: `desconto`, `abatimento`, `cortesia`, `preço especial`, `condição especial`, `baixar o preço`, **`faço por`** | P | CTO | 015a | "aplico três por cento" escala na raia SDR; raia do cotista inalterada (teste) |
| **V-03** (gateway#34) | Templates do agente de vendas aprovados na Meta | P | Externo | — | Template aprovado; habilita prospecção ativa (M5) |
| **P-27** | `docs/roteiro-demo.md` ganha o **Ato 6 — SDR** | P | CTO | 015a | Roteiro com as mensagens exatas e o plano B pelo simulador |

## M2 — Blindagem para exposição (S5–S6)

Itens P/M, sem dependência de contexto profundo da plataforma — **onboarding do dev pleno**
no repositório (premissa D9).

| ID | Item | Tam | Dono | Aceite |
|---|---|---|---|---|
| **P-28** | `env.ts`: com `NODE_ENV=production` o boot **recusa** `WA_VERIFY_TOKEN`, `WA_APP_SECRET`, `BETTER_AUTH_SECRET` nos valores de dev | P | Dev | Teste: boot em prod com default lança com mensagem clara |
| **P-29** | `compose.prod.yml` lê as senhas do Postgres do `.env.prod`; rotacionar `app_owner`/`erp_ro` no homelab | P | Dev | Compose sem senha literal; homelab com senha nova; `deploy.sh` documenta |
| **P-30** | `release.yml` só publica com CI verde (`needs: ci` ou workflow único) | P | Dev | Push com teste quebrado não gera imagem |
| **P-31** | `.env.example` completo (6 variáveis faltando) | P | Dev | Script/diff `env.ts` × exemplo vazio; CI falha se divergir |
| **I-12** (seta-gestao#17) | gitleaks em pre-commit + CI igual ao do gateway (gitleaks, audit) — backlog V2 §8 passo 5 | M | Dev | Hook ativo e documentado; CI com gitleaks/audit |
| **P-32** | `kb:ingest` remove documento cujo arquivo sumiu | P | Dev | Ingest com arquivo removido apaga `documento` + `chunk` |
| **P-33** | Índice HNSW em migração (`0016`); `/` redireciona para `/inbox`; remover `turnoHandlerLog` e comentários "stub até lá"/"POC sem template" | P | Dev | Migração criada; `/` não é placeholder; grep limpo |
| **P-34** | Backup automático do volume Postgres no homelab (cron + `pg_dumpall` + retenção) com **restore testado** | M | Dev | Restore em banco limpo reproduz KB, contatos e cobranças |
| **I-04** (seta-gestao#10) | Monitor de disponibilidade cobre a plataforma: probe em `/healthz` + mensagem de teste periódica pelo simulador | M | Dev | Silêncio de 5 min alerta no `#dev-alertas` |

## M3 — Decisões e pré-requisitos (S4–S7, paralelo; Dono Gestão/Externo)

| ID | Decisão / providência | Dono | Prazo | Se não |
|---|---|---|---|---|
| **D1** | Pagamentos no piloto? Teto? Asaas aceito? (status-do-projeto §9) | Sócios | S6 | M4 sem Asaas produção; 014 segue em `psp: simulado` |
| **D2** = P-18 (#57) | ADR versionamento/release: tag por release, imagem por versão, `configs/<cliente>/` fora da imagem | Gestão | S6 | P-22 sem esquema; deploy por cliente improvisado |
| **D3** | Cliente-piloto. **Premissa: Bali Park** (espelho `bali_tse` em `bali-vps`, 36 tabelas; reunião de terça; papel `bali_agente` já com SELECT revogado em `pessoa`/`contrato`) | Sócios | S5 | M4 sem alvo |
| **D4** | WABA real do piloto — iniciar na Meta **em S4** | Externo | S8 | Piloto limitado a 5 números de teste |
| **D5** | Acesso da plataforma ao espelho (host, role read-only, rede) | Gestão + Externo | S6 | P-36 não começa |
| **D6** | LGPD: política de uso/retenção/descarte + **DPA com o provedor de LLM**; **o dado pseudonimizado pode sair para a Anthropic (EUA)?** | Gestão + Jurídico | S6 | Se não → **P-35** (vLLM on-prem, G) entra em M4; piloto desliza ≥ 2 sprints |
| **D7** = P-20 (seta-gestao#3) | Cobrança da Meta a partir de out/2026: quais templates viram utility; impacta `WA_TEMPLATE_PAGAMENTO_CONFIRMADO` e os disparos da 013 | Gestão | **30/09** | Custo surpresa em outubro |
| **D8** | Provedor de embeddings: OpenAI `text-embedding-3-small` via base URL separada, Voyage ou local | Gestão | S5 | KB e skills continuam lexicais |
| **D9** | Quem constrói a plataforma. **Premissa:** specs (M1, P-36–P-38) = CTO + Claude Code; itens P/M (M2, P-39–P-40) = dev pleno | CTO | S4 | Mapa de sprints muda |

## M4 — Pronto para o piloto (S6–S9) — gated por M3

| ID | Item | Tam | Dono | Depende | Aceite |
|---|---|---|---|---|---|
| **P-36** (spec 016) | **Conexão ao espelho real:** `ERP_DATABASE_URL` → `bali_tse`; validar as 7 views canônicas contra o espelho (012: "a integração é outra sessão"); `DbConnector` não muda; política de masking completa (003: "sem política completa" — hoje só `cnpj`, sem uso) | M–G | CTO | D5 | `titulos_atraso` de um contrato real bate com o TSE; nenhuma coluna de PII passa; `erp_ro` equivalente sem SELECT em tabela física |
| **P-37** (spec 017) | **Embeddings reais:** `EMBEDDING_BASE_URL`/`EMBEDDING_API_KEY` separados no `AIProvider`; re-ingest KB + skills; `EMBEDDING_DIM` casado | M | CTO | D8 | `hybrid` com vetor; teste "híbrida supera lexical" da 008 volta a valer |
| **P-38** (spec 018) | **KB de produtos e cotas + glossário na persona:** OURO/DIAMANTE × PREMIUM/MASTER/SPECIAL, modelos de uso (anual 1–3 períodos, bienal), UH, pontos por tier — a partir do espelho; validada na terça com o Bali | M | CTO + Externo | D5, P-37 | "o que é DIAMANTE PREMIUM?" responde com fonte; agente decodifica o retorno de `meu_produto`; sem PII no repo |
| **P-39** (spec 019) | **Release por cliente** conforme D2: tags `vX.Y.Z`, imagem por versão, `configs/<cliente>/client.yaml` + `contatos.yaml` fora da imagem, staging (decisão M-03 do gateway) | M | Dev | D2 | `TAG=vX.Y.Z CLIENTE=bali ./deploy.sh` sobe o piloto; `/healthz` expõe a versão |
| **P-40** (spec 020) | **Operação mínima:** rate limit em `/webhook` e `/webhooks/asaas`; rota de inspeção de dead-letter (hoje só log); segredos fora do `.env` (cofre — junto com D2); retenção de logs | M–G | Dev | P-28–P-30 | Fase C "preparar a operação" do status-do-projeto coberta item a item |
| **P-41** (spec 021) | **WABA do cliente:** trocar o número de teste; submeter templates 013/014 como utility (D7) | P + espera | Externo + Dev | D4, D7 | Template aprovado; `WA_TEMPLATE_PAGAMENTO_CONFIRMADO` real |
| **P-42** (spec 022) | **LGPD técnico:** retenção/descarte de `mensagem`, `trace_turno`, `evento_*` por política; `contato.documento` só com base legal (014: "em produção viria do cadastro") | M | Dev | D6 | Job de expurgo; documento não vem de YAML |
| **P-35** (spec 023) | **Só se D6 negar:** vLLM on-prem — port já existe; validar tool calling do modelo; infra do cliente | G | CTO + Externo | D6 | `LLM_BASE_URL` interno; suíte do agente verde |
| **P-43** | **Só se D1 sim:** Asaas produção — chave, webhook público, `documento` com base legal | M | Dev | D1, P-42 | Cobrança real paga no piloto |

## M5 — Depois do piloto (sem sprint)

| ID | Item | Origem |
|---|---|---|
| **P-19** (#58) | Adaptador Winthor (Seven): ressuscitar catálogo/views da spec 002 do histórico git como `catalog/seven/` + `erp-mock` alternativo | backlog V2 |
| **P-11** (seta-gestao#2) | Discovery do agente Seven | backlog V2 |
| **E-03 / P-09c** (seta-gestao#1) | Copiloto de cobrança Bali no WhatsApp — a 014 é a semente | backlog V2 |
| **E-04 restante** | P-13c opt-out/lista de supressão; segmentação via catálogo; webhook `message_template_status_update` | spec 013 "fora de escopo" |
| **SDR fase 2** | Prospecção ativa (013 + V-03); raia do cotista (upgrade/cross-sell); parcelamento | spec 015 "fora de escopo" |
| **Fase D** | Config/KB/catálogo pela interface; gestão de usuários; mídia; multi-instância (`debounce.ts:77`, #33); papel `marketing` (013) | status-do-projeto |
| — | `RE_PERCENTUAL` na raia do cotista, se 015c não bastar | PR #60 |

## Reconciliação com o backlog V2 (Project 6 "SETA — Backlog")

| ID V2 | Issue | No Project | Estado real | Ação |
|---|---|---|---|---|
| P-12 | #56 | Backlog, S4 | pendente | mantém (M0) |
| P-13 (E-04) | #54 | Backlog, P1 | **feito** 01/09 20:16 — fatias a, b, d; c (opt-out) fora da 013 | fechar após #59; abrir P-13c em M5 |
| P-14 | #45 | Backlog | **feito** 01/09 | fechar após #59 |
| P-15 | #46 | Backlog | **feito** 01/09 | fechar após #59 |
| P-16 | #47 | Backlog | **feito** 01/09 | fechar após #59 |
| P-17 | #48 | Backlog | **feito** 02/09 21:08 | fecha pelo `Closes #48` do #59 |
| P-18 | #57 | Backlog | pendente | D2 (M3) |
| P-19 | #58 | Backlog, P3 | pendente | M5 |
| V-03 | gateway#34 | Backlog | pendente (Externo) | M1 |
| V-05 | seta-gestao#7 | Backlog | pendente | M0, após P-21 |
| E-05 / P-20 | seta-gestao#3 | Backlog, S4 | pendente | D7 (M3) |
| I-04 | seta-gestao#10 | Backlog | pendente | M2 (estende à plataforma) |
| I-12 | seta-gestao#17 | Backlog | pendente | M2 |
| — | — | — | **spec 015 não existe no V2** | entra como P-24 a P-27 |

**Por que o V2 ficou desatualizado:** foi escrito em 02/09 às 16:06; a 013 ficou pronta em
01/09 às 20:16 e a 014 em 02/09 às 21:08. Os PRs #51–#55 constavam como MERGED no GitHub,
mas mergearam em branches base já absorvidas — o conteúdo nunca chegou no `main`.

## Itens novos para a triagem (P-21 a P-43)

Prontos para copiar no Project 6. Todos `Produto: Plataforma`, `Tipo: Produto`, salvo
onde indicado.

| ID | Título (resultado, não tarefa) | Tipo | Prio | Tam | Dono | Marco |
|---|---|---|---|---|---|---|
| P-21 | Servidor de demonstração roda a versão atual do `main` | Infra | P1 | P | Dev | M0 |
| P-22 | Primeira versão identificada (`v0.1.0`) publicada no GHCR | Infra | P2 | P | Dev | M0 |
| P-23 | Status do projeto de 31/08 versionado no repo e apontando para o roadmap | Produto | P3 | P | Gestão | M0 |
| P-24 | Lead sem cadastro é qualificado e recebe oferta dentro da alçada de 3% (015a) | Produto | P1 | G | CTO | M1 |
| P-25 | Atendente aprova ou recusa proposta acima da alçada pelo console (015b) | Produto | P1 | M | CTO | M1 |
| P-26 | Percentual por extenso não passa na raia do SDR (015c) | Produto | P2 | P | CTO | M1 |
| P-27 | Roteiro de demo tem o Ato 6 — SDR | Pré-venda | P2 | P | CTO | M1 |
| P-28 | Boot em produção recusa chaves de desenvolvimento | Infra | P1 | P | Dev | M2 |
| P-29 | Senhas do Postgres fora do compose e rotacionadas no homelab | Infra | P1 | P | Dev | M2 |
| P-30 | Imagem só é publicada com CI verde | Infra | P1 | P | Dev | M2 |
| P-31 | `.env.example` completo e verificado no CI | Infra | P2 | P | Dev | M2 |
| P-32 | Ingestão da KB remove documento cujo arquivo sumiu | Produto | P2 | P | Dev | M2 |
| P-33 | Índice HNSW em migração; `/` vai para `/inbox`; stubs removidos | Produto | P3 | P | Dev | M2 |
| P-34 | Backup automático do Postgres com restore testado | Infra | P1 | M | Dev | M2 |
| P-35 | LLM dentro da rede do cliente (só se D6 negar) | Produto | — | G | CTO + Externo | M4 |
| P-36 | Plataforma lê o espelho real do cliente-piloto (016) | Produto | P1 | M–G | CTO | M4 |
| P-37 | Busca semântica com embeddings reais (017) | Produto | P1 | M | CTO | M4 |
| P-38 | Agente conhece produtos, tiers e cotas do cliente (018) | Produto | P1 | M | CTO + Externo | M4 |
| P-39 | Instalação por cliente com versão identificada e config fora da imagem (019) | Infra | P1 | M | Dev | M4 |
| P-40 | Operação mínima: rate limit, dead-letter, cofre, retenção de logs (020) | Infra | P1 | M–G | Dev | M4 |
| P-41 | WhatsApp comercial do cliente com templates de utilidade aprovados (021) | Produto | P1 | P | Externo + Dev | M4 |
| P-42 | Retenção e descarte de dados por política LGPD (022) | Produto | P1 | M | Dev | M4 |
| P-43 | Cobrança real via Asaas produção (só se D1 sim) | Produto | — | M | Dev | M4 |

Capacidade indicativa: M0 ≈ 1 dev-dia + CTO · M1 ≈ 3 sessões de spec (CTO) · M2 ≈ 3–4
dev-dias · M4 ≈ 6–8 dev-dias + 3 sessões de spec. Com 6 dev-dias planejados por sprint e 2
deles reservados à Migração (regra fixa do V2), **M2 + M4 cabem entre S5 e S9 se D9
mantiver as specs com o CTO**.

## Como manter este roadmap

- Muda por PR, como qualquer arquivo do repo. A Parte 1 é reescrita quando um marco fecha
  ou uma decisão é tomada; a Parte 2 quando um item muda de estado.
- Os IDs provisórios (P-21+) viram número de issue na triagem de segunda; o roadmap é
  atualizado com o número e o link.
- Regra que nasceu da revisão de 06/09: **"MERGED" não prova que o conteúdo chegou no
  `main`**. Em PR empilhado, conferir `baseRefName` e a ordem dos merges, e verificar por
  conteúdo (`git cat-file -e origin/main:<arquivo marcante>`).
