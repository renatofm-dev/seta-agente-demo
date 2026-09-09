# 032 — Configuração pela interface: instalação, KB, catálogo, metas e usuários

> **Pré-spec / rascunho M5** (08/09/2026): a "Fase D" do status de 31/08. Depende da 021
> (config por cliente fora da imagem) e do piloto.

## Objetivo
Hoje `client.yaml`, `contatos.yaml`, `kb/`, `catalog/` e `skills-seed/` mudam por arquivo
e redeploy; usuários do console nascem no seed. Configurações no console é só leitura, com a
nota "edição pela interface chega com a fase de Configurações". Esta spec faz a fase chegar:
gestor edita a instalação, a KB e as metas pela interface, com validação, versão e auditoria,
sem programador.

## Reaproveita
- `packages/client-config` (schema Zod é a validação), Configurações no console (canal,
  regras, equipe, PSP, ERP, skills — já desenhadas), `kb:ingest`, `loadCatalog`.
- Better Auth (papéis) e `equipe`.
- Versionamento das skills (009) como modelo de "versão + rollback" para config e KB.

## Escopo
- **Instalação**: persona, personaSdr, módulos, limites, temas sensíveis, meta de
  conversão, alçadas (teto, limites por dia, desconto máximo) editáveis por papel `gestor`
  (novo); cada salvamento gera `config_versao` com diff e autor; o server recarrega sem
  reiniciar (hot reload do `ClientConfig` atrás de um port).
- **KB**: upload/edição de Markdown com preview, ingestão ao publicar, versões e
  desativação; fonte e data de validação obrigatórias (020).
- **Catálogo**: leitura completa (SQL, params, colunas) e edição só de `description` e
  `tool.expose` pela interface; SQL continua por PR (segurança).
- **Contatos/vínculos**: importação por CSV com validação, sem CPF (024), e confirmação de
  vínculo.
- **Usuários e papéis**: convidar, papel (`atendente`, `curador`, `gestor`, `comercial`,
  `marketing`), desativar; permissões por rota.

## Fora de escopo
- Multi-instalação num mesmo console (a instalação continua isolada).
- Editor de fluxo do agente (a máquina é código).

## Premissas
- Toda edição pela interface é versionada e reversível; o `client.yaml` no repo vira o
  **seed** da instalação, não a fonte contínua.

## Critérios de aceite
- Gestor muda a meta de conversão e o teto de aprovação pela interface ⇒ relatório e fluxo
  de cobrança usam os novos valores sem redeploy; histórico mostra quem e quando; rollback
  restaura; usuário convidado entra com o papel certo e não vê o que não pode.
