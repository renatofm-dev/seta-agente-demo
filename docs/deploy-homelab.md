# Deploy no homelab (011) — seta.outerlab.com.br

CX23 (2 vCPU / 4 GB / Ubuntu 24.04), Docker Compose + Caddy do host, wildcard
`*.outerlab.com.br` no Cloudflare (proxy laranja LIGADO funciona para o webhook Meta).
**A VPS nunca builda** — o CI (`.github/workflows/release.yml`) publica as imagens no
GHCR a cada push na `main`; o deploy é `pull && up`.

## Preparação (uma vez)

```bash
# 1. swap de 2 GB (obrigatório na CX23)
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# 2. clone raso (só para compose/infra/docs — nada é buildado aqui)
git clone --depth 1 git@github.com:renatofm-dev/seta-agente-demo.git && cd seta-agente-demo

# 3. login no GHCR com PAT (classic) de escopo read:packages
echo "$GHCR_PAT" | docker login ghcr.io -u renatofm-dev --password-stdin

# 4. Caddy do host: importar o site block e recarregar
#    (ajuste o caminho no Caddyfile)
#    import /root/seta-agente/infra/caddy/seta.outerlab.com.br.caddy
sudo systemctl reload caddy
```

## `.env.prod` (na raiz do clone; NUNCA commitar)

```bash
# Postgres do compose (superuser do container)
POSTGRES_PASSWORD=<forte>
# P-29: senhas dos papéis do produto — o init as usa no 1º boot do volume e o
# compose monta DATABASE_URL/ERP_DATABASE_URL com elas. O server RECUSA subir em
# produção com app_owner_dev/erp_ro_dev (P-28). Sem aspas simples, por segurança.
APP_OWNER_PASSWORD=<forte>
ERP_RO_PASSWORD=<forte>

# WhatsApp Meta Cloud API — docs/meta-setup.md
WA_VERIFY_TOKEN=<token do handshake>
WA_APP_SECRET=<app secret>
WA_ACCESS_TOKEN=<token da cloud api>
WA_PHONE_NUMBER_ID=<phone number id>

# LLM (endpoint OpenAI-compatible)
LLM_BASE_URL=https://openrouter.ai/api/v1
LLM_API_KEY=<key>
LLM_MODEL=<modelo>
EMBEDDING_MODEL=<modelo de embedding>
EMBEDDING_DIM=1536
LLM_PRECO_IN_POR_1M=<preço por 1M tokens de entrada>
LLM_PRECO_OUT_POR_1M=<preço por 1M tokens de saída>

# Better Auth
BETTER_AUTH_SECRET=<openssl rand -base64 32>
BETTER_AUTH_URL=https://seta.outerlab.com.br

# Simulador de WhatsApp (plano B da demo) — EXIGE login do console em produção
DEV_SIMULATOR=true
NODE_ENV=production

# Simulador da API do TS Explorer (035) — outro serviço, outro assunto:
# é o dublê do ERP por HTTP, e SOBE COM A DEMO. Sem porta publicada e sem rota
# no Caddy: só o server o alcança, em http://tse-sim:3010.
# A senha é do papel `tse_sim` do erp_mock; o demo-seed.sh cria o papel com ela.
TSE_SIM_DB_PASSWORD=<forte>
# `login:senha:idPessoa` — o boot RECUSA a credencial de exemplo em produção
TSE_SIM_USERS=<login>:<senha forte>:1
# `qualquer` (default) ou `token` — ver D10 em docs/tse-api-setup.md §6
TSE_SIM_PAINEL_ESCOPO=qualquer
LOG_LEVEL=info
```

DATABASE_URL/ERP_DATABASE_URL são montadas no `compose.prod.yml` a partir de
`APP_OWNER_PASSWORD`/`ERP_RO_PASSWORD` (rede interna); os paths ficam no compose.

### Rotação de senha em instalação já existente

O init só roda no primeiro boot do volume. Numa instalação que subiu com as
senhas de dev, rotacione uma vez — a senha entra como variável do psql (`:'pw'`),
nunca interpolada no SQL:

```bash
docker compose -f infra/compose.prod.yml --env-file .env.prod exec db \
  psql -U postgres -v pw="$APP_OWNER_PASSWORD" -c "ALTER USER app_owner PASSWORD :'pw'"
docker compose -f infra/compose.prod.yml --env-file .env.prod exec db \
  psql -U postgres -v pw="$ERP_RO_PASSWORD" -c "ALTER USER erp_ro PASSWORD :'pw'"
docker compose -f infra/compose.prod.yml --env-file .env.prod up -d server
```

Sem isso o `server` não sobe (P-28 recusa a URL com senha de dev) — falha ruidosa,
de propósito.

## Deploy e seed

```bash
./infra/deploy.sh            # pull :latest → migrações → up -d → healthz
./infra/deploy.sh <sha>      # rollback/pin para uma imagem específica

# seed de demo (idempotente): ERP mock + vínculos + usuários + skills + KB
docker compose -f infra/compose.prod.yml --env-file .env.prod \
  exec server sh /app/demo-seed.sh
```

Webhook Meta: apontar para `https://seta.outerlab.com.br/webhook` com o
`WA_VERIFY_TOKEN` acima (o GET do handshake responde na hora); smoke = mensagem
real do celular de teste → resposta no WhatsApp.

### O simulador do TSE (035) sobe junto — e não aparece na internet

`apps/tse-sim` é o dublê da API do TS Explorer: responde no contrato do fornecedor sobre o mesmo
`erp_mock`, e **escreve** (baixa de pagamento, e mais tarde reserva e venda). Sem ele implantado,
tudo que a frente demo constrói existiria só na máquina de quem programou.

O serviço **não tem `ports:`** — igual ao `db`, vive só na rede interna do compose — e o Caddy não
ganha rota para ele. Confirmar depois do deploy:

```bash
# de dentro: responde
docker compose -f infra/compose.prod.yml --env-file .env.prod exec -T tse-sim \
  node -e 'fetch("http://localhost:3010/healthz").then(r=>r.text()).then(console.log)'

# de fora: não alcança nada (ambos devem falhar)
curl -sS --max-time 5 https://seta.outerlab.com.br/token ; curl -sS --max-time 5 http://<IP>:3010/healthz
```

O papel `tse_sim` do banco é criado pelo **seed** (`demo-seed.sh` → `04-sim-role.sql`), com a
senha de `TSE_SIM_DB_PASSWORD`. Rodar o seed **antes** de esperar o simulador funcionar: até lá
ele sobe, mas não conecta (o pool é preguiçoso; o `restart: unless-stopped` cobre o resto).

## Backup e restore (testar UMA vez antes da demo)

```bash
# backup (dump lógico dos dois bancos)
docker compose -f infra/compose.prod.yml --env-file .env.prod \
  exec db pg_dumpall -U postgres | gzip > backup-$(date +%F).sql.gz

# restore (em volume novo: down -v derruba TUDO — só em recuperação)
docker compose -f infra/compose.prod.yml --env-file .env.prod down -v
docker compose -f infra/compose.prod.yml --env-file .env.prod up -d db
sleep 5
gunzip -c backup-<data>.sql.gz | docker compose -f infra/compose.prod.yml \
  --env-file .env.prod exec -T db psql -U postgres
./infra/deploy.sh
```

## Resiliência (critério da 011)

`docker compose restart` no meio de uma conversa não perde mensagens: entrada é
idempotente por `wa_message_id` (a Meta re-entrega), saída fica no outbox com
retry — os testes de integração da 004 cobrem exatamente isso.

## Premissas registradas

- P-28/P-29: os papéis `app_owner`/`erp_ro` nascem com as senhas do `.env.prod`
  (`infra/postgres/init/01-init.sh`); o compose não tem senha literal e o server
  recusa subir em produção com segredo/senha de dev. O banco continua sem porta
  publicada (só rede interna do compose).
- P-30: a imagem só é publicada no GHCR depois do workflow `ci` passar no `main`
  (`release.yml` dispara por `workflow_run`); `workflow_dispatch` republica um
  SHA à mão.
- Imagem do server carrega o monorepo compilado com install prod filtrado
  (`--filter @seta/server...`) — gorda o bastante para rodar seed/ingestão
  dentro do container, pequena o bastante para a CX23.
- `/dev/*` (simulador) exige sessão do console em produção (fix do review).
