# 019 — Embeddings reais: busca semântica na KB e nas skills

> **Pré-spec** (rascunho de 08/09/2026): ainda não executada. Depende de **D8** (provedor de
> embeddings: OpenAI `text-embedding-3-small`, Voyage ou modelo local). Item P-37, marco M4.

## Objetivo
O `AIProvider` usa uma única base URL para chat e embeddings; com a Anthropic como provedor
de chat, `EMBEDDING_MODEL` fica vazio e a KB e as skills entram só na busca lexical. A busca
híbrida da 008 (denso + lexical com RRF) existe e está testada, mas roda com metade. Esta
spec separa o endpoint de embeddings, reingere KB e skills com vetores reais e faz o teste
"híbrida supera lexical" voltar a valer.

## Reaproveita
- `packages/ai-provider/src/openai-compatible.ts:107` (`embed` já implementado; só a base
  URL e a chave são compartilhadas).
- `packages/rag` (`chunk`, `rrf`, `VectorStore`), `apps/server/src/rag/pgvector-store.ts`
  (`ensureIndex`, cast por `EMBEDDING_DIM`), `kb-ingest.ts` (remove documento órfão desde
  P-32), `skills/registry.ts › sincronizar` (reposiciona skills no store).
- `packages/anonimizacao` já anonimiza o texto antes de `embed` (sem destokenizar).
- Teste da 008 em `rag.integration.test.ts` (o caso "híbrida supera lexical" está com
  embeddings fake de 8 dimensões).

## Escopo

### `packages/ai-provider`
- Config ganha `embeddingBaseUrl?`, `embeddingApiKey?`; `embed` usa esses quando presentes,
  senão os de chat (compatibilidade). Erro claro quando `EMBEDDING_MODEL` está sem endpoint
  que o sirva.
- Opcional (se D8 escolher local): implementação `createLocalEmbeddingProvider` com
  `@huggingface/transformers` (já aprovado) — só se o modelo couber no servidor pequeno;
  decisão na execução.

### Server
- Env: `EMBEDDING_BASE_URL`, `EMBEDDING_API_KEY` (opcionais), `EMBEDDING_DIM` obrigatório
  quando `EMBEDDING_MODEL` está definido; boot valida que a dimensão do primeiro `embed`
  bate com `EMBEDDING_DIM` (senão derruba: índice e cast ficariam inconsistentes).
- Migração: trocar `EMBEDDING_DIM` exige reconstruir `chunk.embedding` e o índice HNSW —
  script `pnpm kb:reindex` (apaga chunks, reingere, `sincronizar` das skills).
- Custo dos embeddings no `/metricas` (`evento_llm` com `operacao: embed`, preço próprio
  `EMBEDDING_PRECO_POR_1M`).

### Testes
- `rag.integration.test.ts`: caso "híbrida supera lexical" com um provedor fake
  determinístico de dimensão real (não 8) e um caso de paráfrase ("distrato" encontra
  "cancelamento").
- Teste de `ai-provider` para a separação de endpoints.

## Fora de escopo
- Reranker, chunking semântico, KB multi-idioma.
- Mudar o provedor de chat.
- Embeddings de mensagens da conversa (só KB e skills, como na 008).

## Premissas
- O provedor de embeddings recebe texto anonimizado (016); ainda assim é um fornecedor a
  mais para o DPA da D6 — registrar.
- `EMBEDDING_DIM` do piloto = a do modelo escolhido (1536 para `text-embedding-3-small`);
  o `.modelos/` da anonimização não é reaproveitado (modelo diferente).

## Critérios de aceite
- Com `EMBEDDING_*` reais: `pnpm kb:ingest` grava vetores; `buscar_conhecimento("como
  cancelar")` devolve o documento de distrato no top-1; skill aprovada aparece no contexto
  por similaridade, não só por termo.
- Dimensão errada derruba o boot com mensagem; `kb:reindex` reconstrói do zero.
- `evento_llm` registra tokens de embed; `/metricas` soma no custo.
- Teste "híbrida supera lexical" verde com o fake de dimensão real; `pnpm lint && pnpm test
  && pnpm build` verdes.
