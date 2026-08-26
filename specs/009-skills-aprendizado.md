# 009 — Skills + loop de aprendizado

## Objetivo
O diferencial da demo: sinais de produção viram propostas; humano aprova no dashboard;
skill versionado entra no contexto e melhora o agente visivelmente.

## Escopo
- Formato: `SKILL.md` compatível agentskills.io + bloco `x-seta` no frontmatter
  (escopo, gatilho, tools, métricas, proveniência). Parser + validador Zod.
- Modelos: `skill` (id lógico, escopo `local`, forkDe?), `skill_versao` (corpo, frontmatter,
  embedding, status `proposta|em_revisao|ativa|arquivada|rejeitada`, criadoPor
  `distiller|humano`, aprovadoPor/Em, propostaId), `proposta` (tipo `skill_novo|skill_patch|
  exemplar|lacuna_kb|lacuna_catalogo`, diff, evidência, sinais[]), `sinal_aprendizado`
  (tipo `correcao_hitl|escalonamento|verdict_guardrail|resolucao_limpa|re_pergunta`, refs),
  `caso_eval` (input, comportamento esperado, origem).
- `packages/skills`:
  ```ts
  interface SkillRegistry {
    activeFor(ctx, k): Promise<Skill[]>;       // retrieval semântico (ns 'skills') + boost por métrica
    approve(versaoId, revisor, edits?): Promise<SkillVersion>;  // imutável; recomputa embedding
    reject(propostaId, revisor, motivo): Promise<void>;         // motivo vira sinal
    rollback(skillId, paraVersao, motivo): Promise<void>;
    deactivate(skillId, motivo): Promise<void>; // kill-switch
  }
  ```
  Integração na montagem de contexto (005): top-2 skills; ids gravados no trace ⇒
  atribuição de uso e de resolução por skill.
- **Coleta de sinais**: correção HITL (007), verdicts (006), escalonamentos, `resolucao_limpa`
  (job diário: resolvido sem humano e sem recontato em 48 h), re-pergunta (heurística simples).
- **Distiller on-demand** (`POST /api/aprendizado/gerar` + botão no console): agrupa sinais
  não processados por similaridade, roda prompt de destilação (LLM, saída estruturada Zod)
  e cria propostas com evidência (métricas do cluster + trechos). Toda proposta gera também
  um `caso_eval` do trace real. Prompt de destilação versionado em arquivo.
- Console — aba **Aprendizado**:
  - Fila de propostas: card com diff (novo = corpo inteiro), evidência, impacto estimado
    (nº de conversas no cluster). Ações: aprovar · editar-e-aprovar · rejeitar com motivo.
  - Catálogo de skills: versão ativa, usos, taxa de resolução com o skill no contexto,
    histórico de versões, rollback 1 clique, kill-switch.
  - Papel `curador` obrigatório; aprovação carimba revisor na versão.
- Seed: 2 skills escritos à mão em `skills-seed/` (importados no seed) provando o formato.

## Critérios de aceite
- Roteiro do Ato 3 completo: sinais dos atos 1–2 → gerar → aprovar → skill influencia a
  resposta seguinte (verificável no trace: skill presente no contexto).
- Versões imutáveis: aprovar edição cria versão nova; rollback reativa anterior (testes).
- Rejeição gera `sinal_aprendizado`; kill-switch remove do retrieval imediatamente.
- Cadeia de auditoria navegável: sinal → proposta → revisor → versão → turnos que usaram.
