# 016 — Anonimização do que sai para a LLM

## Objetivo
Hoje o dado estruturado do ERP já sai pseudonimizado (012: `v_cotista` sem nome/CPF; o
`output.columns` do catálogo é whitelist e nenhuma coluna carrega identificador pessoal).
O que **não** está protegido é o **texto livre**: a mensagem do cotista ("meu CPF é…", "sou
o João da Silva", telefone, e-mail), a do atendente no histórico e o resumo rolante que a
LLM gera a partir dos dois. Esse texto passa pelos cinco chamadores do `AIProvider` (agente,
classificador de intenção, resumidor, intérprete da cobrança, distiller) e chega ao
provedor remoto — a decisão D6 do roadmap ("o dado pode sair para a Anthropic?").

Esta spec entrega um **decorator do port `AIProvider`** que troca PII por tokens estáveis
antes de qualquer chamada e restaura o texto na resposta. Um ponto de corte cobre os cinco
chamadores sem que nenhum deles mude. Nome e CPF do cotista passam a **nunca** transitar;
a conversa da D6 muda de "dado de cotista sai" para "sai texto pseudonimizado".

## Escopo

### `packages/anonimizacao` — port `Detector` + anonimizador + decorator
- **`Detector`** (`nome`, `detectar(texto) → Deteccao[]` com `tipo, inicio, fim, valor`).
  Três implementações:
  - **regex** com validação: CPF e CNPJ (dígito verificador), cartão (Luhn, 13–19 dígitos),
    telefone BR (DDD 11–99, ou formatado com hífen), e-mail, CEP (`00000-000` ou após
    "cep"), placa Mercosul/antiga. Validação de DV é o que evita falso positivo em número
    de contrato, valor em centavos e id.
  - **dicionário + gatilhos**: nomes conhecidos do contexto (`contato.nome`, apelido do
    vínculo — partes com ≥ 3 letras, sem dígitos), e frases-gatilho ("meu nome é X", "me
    chamo X", "aqui é o/a X", "sou o/a X").
  - **NER local**: `@huggingface/transformers` (ONNX em Node, sem Python) com
    `Xenova/distilbert-base-multilingual-cased-ner-hrl` quantizado (135 MB), só label `PER`.
    Import dinâmico (o package funciona sem o modelo), cache LRU por texto (o histórico se
    repete a cada turno — NER só roda no que é novo), janelas de ~1.500 caracteres por
    quebra de linha (limite de 512 tokens do modelo), erro de inferência não derruba a
    chamada (loga e segue com regex + dicionário).
- **`Cofre`** por chamada: token `[TIPO_n]` (`CPF`, `CNPJ`, `TEL`, `EMAIL`, `CEP`, `CARTAO`,
  `PLACA`, `NOME`) numerado por ordem de aparição; mesmo valor (normalizado: CPF com ou sem
  pontuação, nome sem caixa) ⇒ mesmo token dentro da chamada; `destokenizar` tolera variação
  de caixa/espaço que a LLM introduz e deixa token desconhecido como está.
- **`Anonimizador`**: roda os detectores, resolve sobreposição (o span mais longo vence),
  substitui do fim para o início, conta por tipo.
- **`createAnonymizingProvider(inner, { anonimizador, sink })`**: em `chat`, anonimiza
  `content` de toda mensagem (`system`, `user`, `assistant`, `tool`) e `argumentsJson` de
  tool calls no histórico, chama o provider real, **destokeniza** `content` e os argumentos
  das tool calls da resposta; em `embed`, anonimiza sem destokenizar. Emite ao `sink`
  `{ traceId?, operacao, modelo, substituicoes, total, latenciaMs }` — contagens, nunca
  valores. `ChatRequest.anonimizacao.destokenizar = false` deixa a resposta tokenizada
  (o distiller usa: skill generalizada com `[NOME_1]` em vez de nome real).

### `packages/ai-provider`
- `ChatRequest` ganha `traceId?` (atribuição no trace) e `anonimizacao?.destokenizar?`.
  Sem mudança de comportamento para quem não usa.

### Chamadores passam `traceId`
- `agent/graph.ts` (`session.traceId`), `guardrails/intencao.ts` e `cobranca/interpretar.ts`
  (parâmetro opcional `opts.traceId`), resumo em `turno-handler.ts`, `skills/distiller.ts`
  (`traceIdRodada`, com `destokenizar: false`).

### Server
- `apps/server/src/anonimizacao.ts`: monta os detectores (regex; dicionário lendo
  `contato.nome` com TTL de 60 s; NER com `pronto()` no boot — falha de carga do modelo
  **não derruba o boot**, loga e segue sem NER) e o **acumulador por `traceId`** que o
  turno-handler drena para o trace como evento `{ tipo: 'anonimizacao', chamadas,
  substituicoes, latenciaMs }`. O trace prova *quanto* foi trocado sem gravar *o quê*.
- `index.ts`: com `LLM_ANONIMIZAR=true` (default) o provider real é envolvido pelo
  decorator antes de chegar aos chamadores. Boot loga `anonimizacao: regex+dicionario+ner`
  (ou sem `ner`).
- Env: `LLM_ANONIMIZAR` (default `true`), `ANONIMIZACAO_NER` (default `true`),
  `ANONIMIZACAO_NER_MODELO`, `ANONIMIZACAO_MODELOS_DIR` (default `.modelos`),
  `ANONIMIZACAO_NER_DOWNLOAD` (default `true`; em produção o modelo já vem na imagem).
- `TraceEvento` ganha a variante `anonimizacao`.

### Build e imagem
- `pnpm anonimizacao:modelo` baixa o modelo para `ANONIMIZACAO_MODELOS_DIR`.
- `server.Dockerfile` roda o download na build: a imagem já carrega o modelo, o container
  sobe sem rede para o Hugging Face. `.modelos/` no `.gitignore`.
- `CLAUDE.md` registra `@huggingface/transformers` como dependência aprovada (2026-09-06).
- dependency-cruiser: `anonimizacao` só conhece `ai-provider` — nunca catálogo, connector,
  agent ou guardrails.

## Fora de escopo
- Anonimizar o que fica **no nosso banco** (`mensagem`, `trace_turno`, resumo): é retenção
  e descarte — spec 022 (LGPD técnico) no roadmap. Aqui o alvo é o que **sai**.
- Endereço postal e datas de nascimento sem gatilho (LOC do NER dá falso positivo em
  "Torre 2", "Mirante da Serra"; data é vencimento na maior parte das vezes).
- Anonimizar logs do pino, o console ou a KB ingerida (`kb:ingest` não passa pelo
  decorator — conteúdo institucional).
- Trocar o provedor de LLM ou rodar on-prem (P-35 do roadmap, se a D6 exigir).
- DPA com o provedor: continua necessária para o resíduo que regex+NER não pegam.

## Premissas
- **Valores em R$, datas e números de parcela não são PII isolados** e não são
  tokenizados — o `guardrailPreco` precisa vê-los para rastrear ao resultado da tool.
- **Números de contrato e códigos de cota** também não: só têm significado com o vínculo,
  que nunca sai; e as tools do catálogo já não os devolvem em `output.columns`.
- A numeração dos tokens é **estável dentro de uma chamada** (o histórico inteiro é
  reenviado a cada turno, em ordem, então `[NOME_1]` é a mesma pessoa do começo ao fim).
  Entre chamadas o cofre é novo — por isso a resposta é sempre destokenizada antes de
  persistir e retokenizada na chamada seguinte.
- Tokens são em português e maiúsculos (`[NOME_1]`) porque a LLM os preserva melhor do
  que placeholders opacos; a destokenização é tolerante a caixa e espaço.
- O anonimizador é **estrito**: erro no regex ou no dicionário propaga (o grafo cai no
  fallback honesto). Só o NER é resiliente em inferência — perda de recall, nunca de
  disponibilidade.
- Sem `@huggingface/transformers` instalado ou sem modelo, regex + dicionário seguem
  funcionando; NER é aditivo.
- O modelo NER é multilíngue (HRL: inclui português) e foi treinado em notícia — nomes
  em texto de WhatsApp (minúsculas, sem sobrenome) têm recall menor; o dicionário de
  contexto cobre o caso mais comum (o nome do próprio contato).
- Testes do NER real são `skipIf` sem o modelo em cache — o CI não baixa 135 MB.

## Critérios de aceite
- Com `FakeAIProvider` atrás do decorator: mensagem "meu cpf é 529.982.247-25, sou o Renato
  Martins, fone (61) 98224-8071, renato@x.com" chega ao fake como
  `meu cpf é [CPF_1], sou o [NOME_1], fone [TEL_1], [EMAIL_1]` — e `fake.requests` não
  contém nenhum dos valores originais.
- Resposta do fake `"Certo, [NOME_1], anotei o [CPF_1]."` volta ao chamador com os valores
  reais; tool call com `motivo: "cliente [NOME_1] pediu"` volta com o nome real.
- Mesmo CPF com e sem pontuação no histórico ⇒ um único token; dois nomes diferentes ⇒
  `[NOME_1]` e `[NOME_2]`.
- Número de contrato `10001`, `R$ 208.250,00`, `20825000` centavos e data `2026-09-06`
  **não** são tokenizados (teste de falso positivo).
- Token que a LLM inventou (`[NOME_9]`) fica como está e é contado no sink.
- `destokenizar: false` devolve a resposta tokenizada.
- `embed(["meu cpf 529.982.247-25"])` chega ao fake anonimizado.
- Turno pelo simulador com PII na mensagem: o trace tem evento `anonimizacao` com
  `substituicoes.cpf ≥ 1` e o `fake.requests` do turno inteiro (classificador + agente)
  não contém o CPF.
- Com `LLM_ANONIMIZAR=false` o provider não é envolvido (boot loga `anonimizacao: off`).
- NER real (`skipIf` sem modelo): "Falei com o Carlos Eduardo Pereira ontem" ⇒ uma detecção
  `nome` cobrindo "Carlos Eduardo Pereira".
- `pnpm lint && pnpm test && pnpm build` verdes.
