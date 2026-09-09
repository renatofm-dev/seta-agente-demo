# 021 — Release por cliente: versão identificada, imagem por versão, config fora da imagem

> **Pré-spec** (rascunho de 08/09/2026): ainda não executada. Depende de **D2** (ADR de
> versionamento e instalação, #57). Item P-39, marco M4.

## Objetivo
A plataforma se instala isolada por cliente, mas hoje só existe `latest` e `<sha>` no GHCR,
a config do cliente (`configs/demo/`) vai dentro da imagem e `/healthz` não diz que versão
roda. Sem isso, cada instalação vira improviso e ninguém sabe o que está onde. Esta spec
define o esquema de versão, gera imagem por versão, tira a config do cliente da imagem e dá
um comando de deploy por cliente e por versão, com staging.

## Reaproveita
- `.github/workflows/release.yml` (build só com CI verde, tags `latest` e `<sha>`).
- `infra/deploy.sh` (`TAG`), `infra/compose.prod.yml` (`${TAG:-latest}`), `docker/*.Dockerfile`.
- `env.ts`: `CLIENT_CONFIG_PATH`, `CATALOG_DIR`, `CONTATOS_PATH`, `SKILLS_SEED_DIR`, `KB_DIR`
  já são caminhos configuráveis — a config fora da imagem é só montar um volume.
- `app.ts:81` `/healthz`.
- Decisão M-03 do gateway (staging) e o backlog V2 §8.

## Escopo

### Versão
- ADR 0002: SemVer `vX.Y.Z`; `X` muda em quebra de contrato do catálogo/views ou migração
  destrutiva; `Y` a cada spec entregue; `Z` correção. Tag no `main` cria a release.
- `release.yml`: em `push` de tag `v*`, publica `:vX.Y.Z`, `:vX.Y` e `:latest`; o build por
  SHA continua para `main`. `package.json` da raiz carrega a versão; o build injeta
  `SETA_VERSAO` (tag ou `sha`) nas duas imagens.
- `/healthz` devolve `versao`, `sha`, `cliente`; o console mostra a versão em Configurações
  e no rodapé do login (`v0.9 · piloto` do design vira real).

### Config por cliente
- Layout `configs/<cliente>/{client.yaml,contatos.yaml,catalog/,kb/,skills-seed/}` (o que
  não existir cai no default do repo); a imagem não contém `configs/` de cliente algum.
- `compose.prod.yml` monta `./configs/${CLIENTE}` em `/config` e aponta as envs; `.env.prod`
  ganha `CLIENTE` e `TAG`.
- `infra/deploy.sh`: `TAG=v0.2.0 CLIENTE=bali ./infra/deploy.sh`; valida que a pasta existe
  e que o `client.yaml` passa no schema **antes** de trocar a imagem; migração; healthcheck
  confere a versão.
- Segredos do cliente (`.env.prod`) fora do repo; o repo guarda só `configs/<cliente>` sem
  segredo (024 trata o CPF do `contatos.yaml`).

### Staging
- Segundo compose (`compose.staging.yml`) no mesmo host com portas e banco próprios;
  `deploy.sh --staging` sobe a tag candidata lá; promoção = mesmo comando sem a flag.

### Documentação
- `docs/dev/07-operacao-e-deploy.md` e `deploy-homelab.md` refletem o fluxo; runbook de
  rollback (`TAG` anterior + `migrate` é forward-only ⇒ rollback de banco só por backup
  da 026).

## Fora de escopo
- Registry privado próprio, assinatura de imagem, SBOM.
- Multi-instância no mesmo host além de prod + staging (034).
- Configuração pela interface (032).

## Premissas
- Migrações são forward-only; rollback de versão que inclui migração exige restaurar backup.
- O cliente-piloto roda no nosso homelab (D3); instalação na infra do cliente usa o mesmo
  `deploy.sh`.

## Critérios de aceite
- `git tag v0.1.0 && git push --tags` ⇒ imagens `:v0.1.0` no GHCR só se o CI passou.
- `TAG=v0.1.0 CLIENTE=bali ./infra/deploy.sh` sobe o piloto com a config de `configs/bali`;
  `/healthz` mostra `versao: v0.1.0` e `cliente: <nome do yaml>`; o console exibe a versão.
- `client.yaml` inválido aborta o deploy antes de trocar a imagem.
- Staging e produção convivem no host; promoção sem rebuild.
- `pnpm lint && pnpm test && pnpm build` verdes; ADR 0002 no repo.
