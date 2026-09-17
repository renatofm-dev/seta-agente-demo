# Deploy da demo — VPS da SETA (Coolify), `demo.setaia.com.br`

Este é o caminho **real** da demo. O [deploy-homelab.md](deploy-homelab.md) descreve o outro
caminho (máquina dedicada com Caddy do host) e continua válido — mas não é por onde a demo vai.

## A máquina não é crua: ela roda Coolify

VPS `162.55.51.98` (8 vCPU, 15 GB). Quem manda no `:80`/`:443` é o **`coolify-proxy`, que é o
Traefik v3.6**, orquestrado pelo **Coolify 4.0.0-beta.459**. Já moram lá: n8n (+ Postgres + Redis +
2 runners), Evolution API, Supabase inteiro, Qdrant, gotenberg e imgproxy. **Sobram ~4 GB de RAM.**

Três consequências que mudam tudo em relação ao homelab:

1. **Não se sobe nada com `docker compose up` na mão.** Container que o Coolify não conhece não
   recebe label do Traefik e simplesmente não é roteado — fica de pé sem ninguém alcançar.
2. **`infra/caddy/*.caddy` não serve aqui.** Quem roteia é o Traefik, e sob Coolify os labels são
   gerados pela plataforma.
3. **`infra/deploy.sh` também não.** O Coolify faz `pull → up` sozinho; por isso o
   `infra/compose.coolify.yml` roda a **migração no start do server**.

A stack da demo (Postgres+pgvector, server com o modelo NER embarcado, console, tse-sim) pesa
~1,5–2 GB. Cabe nos ~4 GB livres, sem folga — **não aumente os `NODE_OPTIONS`** numa caixa
compartilhada.

## Dois domínios, e por quê

| host | serviço | para quê |
|---|---|---|
| `demo.setaia.com.br` | `console` (`:3000`) | a demo que se mostra; o Next reescreve `/api/*` para o server pela rede interna |
| `api.demo.setaia.com.br` | `server` (`:3001`) | **só** os webhooks: Meta e Asaas |

O DNS já está pronto: `setaia.com.br` responde em curinga e os dois nomes já apontam para
`162.55.51.98`, com **registro A direto** (não é proxy do Cloudflare) — o Let's Encrypt HTTP-01 do
Traefik funciona sem ajuste.

**Por que não um domínio só:** o HMAC do webhook da Meta é calculado sobre o **corpo cru**
(`apps/server/src/wa/routes.ts` registra um parser `parseAs: 'buffer'` justamente para isso). Passar
o webhook por um hop extra de proxy do Next é risco de quebrar a assinatura — e é o tipo de coisa
que só aparece na hora da demo. Dois hosts também é o padrão que a máquina já usa: **todos** os
roteadores do Traefik ali são `Host(...) && PathPrefix(/)`.

Efeito colateral que é uma propriedade boa: `BETTER_AUTH_URL` é o host do console, então o cookie de
sessão **não viaja** para `api.demo.setaia.com.br` — `/api/console/*` exposto no host de API responde
401 sempre. Quem funciona lá é só quem tem autenticação própria (HMAC da Meta, token do Asaas).

**E o `tse-sim` não recebe FQDN nenhum.** É o dublê do ERP; dar domínio a ele seria o erro a evitar.

## Preparação (uma vez)

1. **Credencial do GHCR no Coolify.** As imagens são privadas:
   `ghcr.io/renatofm-dev/seta-agente-demo-{server,console,tse-sim}`. Em *Settings → Docker
   Registries*, adicionar `ghcr.io` com um PAT classic de escopo `read:packages`.
2. **Nada de DNS a criar** — o curinga já resolve.

## Criar a aplicação

*New Resource → Docker Compose* (não "Docker Image"), apontando para este repositório, branch
`main`, arquivo **`infra/compose.coolify.yml`**.

Nos domínios, atribuir **por serviço**:

- `console` → `https://demo.setaia.com.br`
- `server` → `https://api.demo.setaia.com.br`

> **Se a sua versão do Coolify não deixar dar um domínio por serviço** (nenhuma aplicação nessa VPS
> usa isso hoje, então não foi possível confirmar antes), vá para o [plano B](#plano-b-um-domínio-só).

## Variáveis

Vão na UI do Coolify — **não** existe `.env.prod` no disco aqui. As obrigatórias (o compose aborta
sem elas) estão marcadas com ✱.

| grupo | variáveis |
|---|---|
| Postgres | ✱`POSTGRES_PASSWORD`, ✱`APP_OWNER_PASSWORD`, ✱`ERP_RO_PASSWORD` |
| Console público | ✱`BETTER_AUTH_URL=https://demo.setaia.com.br`, ✱`BETTER_AUTH_SECRET` (`openssl rand -base64 32`) |
| WhatsApp | ✱`WA_VERIFY_TOKEN`, ✱`WA_APP_SECRET`, `WA_ACCESS_TOKEN`, `WA_PHONE_NUMBER_ID`, `WA_WABA_ID`, `WA_TEMPLATE_*` |
| LLM | `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, `EMBEDDING_MODEL`, `EMBEDDING_DIM`, `LLM_PRECO_*` |
| Asaas | `ASAAS_BASE_URL`, `ASAAS_API_KEY`, `ASAAS_WEBHOOK_TOKEN` |
| ERP / TSE | ✱`TSE_USERNAME`, ✱`TSE_PASSWORD`, `TSE_RESERVA_USERNAME`, `TSE_RESERVA_PASSWORD`, `ERP_CONCILIACAO` |
| Simulador do TSE | ✱`TSE_SIM_DB_PASSWORD`, ✱`TSE_SIM_USERS` (`login:senha:idPessoa`), `TSE_SIM_PAINEL_ESCOPO` |
| Outros | `TAG` (default `latest`; use o SHA para pinar), `DEV_SIMULATOR`, `LOG_LEVEL` |

O boot **recusa** subir em `NODE_ENV=production` com segredo de exemplo (P-28): `WA_VERIFY_TOKEN`,
`WA_APP_SECRET` e `BETTER_AUTH_SECRET` nos valores de dev, senha de dev nas URLs do banco, ou
`TSE_USERNAME/PASSWORD` = `integracao`. Se o container morrer no start, leia o log: ele nomeia a
variável.

## Primeiro deploy e seed

O deploy do Coolify sobe o compose e o **server migra sozinho** no start. O **seed é passo à
parte**, manual e idempotente:

```bash
ssh hetzner-seta
docker exec $(docker ps -qf name=seta-agente-server) sh /app/demo-seed.sh
```

Ele faz, nesta ordem: schema+dados do `erp_mock` (e **cria o papel `tse_sim`**), usuários/vínculos/
skills do app, e a ingestão da KB. **Enquanto o seed não roda, o `tse-sim` sobe mas não conecta** —
o papel dele nasce ali. E sem o seed não há usuário para logar no console.

> O seed inclui `kb:ingest`. A 038 mudou o texto da KB sobre reservas: sem reindexar, o RAG
> responde o texto antigo e o agente se contradiz no meio da demo.

## Webhooks (fora do repo)

- **Meta** → `https://api.demo.setaia.com.br/webhook`, com o `WA_VERIFY_TOKEN` acima. Lembre de
  **remover o `override_callback_uri`** do número de teste, que aponta para o túnel de dev — ver
  [dev/09-whatsapp-real-e-tunel.md](dev/09-whatsapp-real-e-tunel.md).
- **Asaas** → `https://api.demo.setaia.com.br/webhooks/asaas`, com o `ASAAS_WEBHOOK_TOKEN` no header
  `asaas-access-token`.

## Checagens pós-deploy

Três caminhos mudam aqui em relação ao homelab, e é por isso que estas checagens existem.

```bash
# 1. o server responde no host de API
curl -fsS https://api.demo.setaia.com.br/healthz

# 2. a verificação do webhook da Meta (o mesmo GET que o painel dela faz)
curl -sS "https://api.demo.setaia.com.br/webhook?hub.mode=subscribe&hub.verify_token=<WA_VERIFY_TOKEN>&hub.challenge=42"
# → 42

# 3. o console responde no host público
curl -sS -o /dev/null -w '%{http_code}\n' https://demo.setaia.com.br/   # → 200

# 4. o simulador do TSE está de pé POR DENTRO…
ssh hetzner-seta 'docker exec $(docker ps -qf name=seta-agente-server) \
  node -e "fetch(\"http://tse-sim:3010/healthz\").then(r=>r.text()).then(console.log)"'
# …e INALCANÇÁVEL por fora (ambos devem falhar):
curl -sS --max-time 5 http://162.55.51.98:3010/healthz
curl -sS --max-time 5 https://api.demo.setaia.com.br/../
```

E duas checagens que só a tela mostra:

- **Login no console.** O Better Auth usa `BETTER_AUTH_URL` como `baseURL`; se o domínio estiver
  errado, o login falha com cookie que não volta.
- **O `/inbox` atualiza sozinho.** No homelab o Caddy mandava `/api/console/*` **direto** ao server;
  aqui esse tráfego passa pelo rewrite do Next. O inbox cai para polling de 3 s se o SSE falhar —
  então o risco é degradação, não queda, mas vale olhar se a lista se move sem F5.

## Plano B: um domínio só

Se o Coolify dessa versão não permitir um FQDN por serviço, exponha **só o console** em
`demo.setaia.com.br` e leve os webhooks pelo Next:

```ts
// apps/console/next.config.ts — acrescentar ao rewrites()
{ source: '/webhook', destination: `${SERVER_URL}/webhook` },
{ source: '/webhooks/:path*', destination: `${SERVER_URL}/webhooks/:path*` },
```

Atenção: o rewrite é resolvido **no build** (`infra/docker/console.Dockerfile` fixa
`SERVER_INTERNAL_URL`), então isso exige **imagem nova** — não basta mexer na variável.

E **teste a assinatura antes da demo**, sem depender da Meta: o repo tem `signBody` em
`packages/wa-meta/src/signature.ts`. Gere um POST assinado contra a URL pública e confirme que o
server aceita; se voltar 401, o hop do Next mexeu no corpo e o caminho é voltar para dois hosts.

## O que NÃO fazer

- **Não** rodar `docker compose -f infra/compose.prod.yml up` nessa VPS: publica portas em
  `127.0.0.1` que o Traefik em container não alcança, e cria containers órfãos do Coolify.
- **Não** dar domínio ao `tse-sim`.
- **Não** apontar a demo para o Postgres do Supabase que já roda lá: acoplaria os ciclos de vida (um
  restore do produto derrubaria a demo) e o nosso precisa de pgvector na versão que a 008 espera.
