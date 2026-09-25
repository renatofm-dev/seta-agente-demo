#!/usr/bin/env bash
# Monta o bloco de variáveis do deploy (Coolify) a partir do .env de dev,
# GERANDO o que não pode ser reaproveitado.
#
# Uso:  pnpm envs-coolify > /tmp/coolify.env   (e cole na UI do Coolify)
#
# Por que este script existe: o boot RECUSA subir em produção com segredo de dev
# (P-28), e a lista de variáveis é longa o bastante para alguém esquecer uma —
# e a que faltar aparece como defeito na demo, não como erro no start. Aqui a
# regra fica explícita: o que é credencial de terceiro (Meta, Asaas, LLM) vem do
# .env porque é a MESMA; o que é senha nossa nasce novo.
#
# ATENÇÃO: a saída contém segredos. Não commite, não cole em chat, não salve no
# repo — o .gitignore cobre `*.env`, mas o cuidado é seu.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env ] || { echo "erro: .env não encontrado na raiz do repo" >&2; exit 1; }
set -a
# shellcheck disable=SC1091
. ./.env
set +a

# host público do console e do server — ajuste se o domínio mudar
CONSOLE_URL="${CONSOLE_URL:-https://demo.setaia.com.br}"
API_URL="${API_URL:-https://api.demo.setaia.com.br}"

senha() { openssl rand -base64 24 | tr -d '/+=' | cut -c1-28; }
segredo() { openssl rand -base64 32; }

# credencial de operador do TSE: NÃO pode ser `integracao` (o boot recusa), e
# tem de existir em TSE_SIM_USERS — é o dublê que valida o login
TSE_USER_PROD="${TSE_USER_PROD:-TSE.DEMO}"
TSE_PASS_PROD="$(senha)"

cat <<EOF
# ── gerado por tools/envs-coolify.sh em $(date '+%d/%m/%Y %H:%M') ──
# Senhas NOVAS (o boot recusa as de dev em produção)
POSTGRES_PASSWORD=$(senha)
APP_OWNER_PASSWORD=$(senha)
ERP_RO_PASSWORD=$(senha)
TSE_SIM_DB_PASSWORD=$(senha)
BETTER_AUTH_SECRET=$(segredo)

# Hosts públicos — PUBLIC_BASE_URL é o host do SERVER (046: página de assinatura)
BETTER_AUTH_URL=$CONSOLE_URL
PUBLIC_BASE_URL=$API_URL

# Credencial de operador do TSE: usuário novo, e o dublê tem de conhecê-lo
TSE_USERNAME=$TSE_USER_PROD
TSE_PASSWORD=$TSE_PASS_PROD
TSE_SIM_USERS=$TSE_USER_PROD:$TSE_PASS_PROD:1
TSE_RESERVA_USERNAME=${TSE_RESERVA_USERNAME:-AGENTE.SETA}
TSE_RESERVA_PASSWORD=$(senha)

# WhatsApp: credenciais da Meta — as MESMAS do dev (são do app, não do ambiente)
WA_VERIFY_TOKEN=${WA_VERIFY_TOKEN:-}
WA_APP_SECRET=${WA_APP_SECRET:-}
WA_ACCESS_TOKEN=${WA_ACCESS_TOKEN:-}
WA_PHONE_NUMBER_ID=${WA_PHONE_NUMBER_ID:-}
WA_WABA_ID=${WA_WABA_ID:-}
WA_TEMPLATE_COBRANCA_PIX=${WA_TEMPLATE_COBRANCA_PIX:-}
WA_TEMPLATE_COBRANCA_BOLETO=${WA_TEMPLATE_COBRANCA_BOLETO:-}
WA_TEMPLATE_COBRANCA_CARTAO=${WA_TEMPLATE_COBRANCA_CARTAO:-}
WA_TEMPLATE_BOLETO_SEGUNDA_VIA=${WA_TEMPLATE_BOLETO_SEGUNDA_VIA:-}
WA_TEMPLATE_PAGAMENTO_CONFIRMADO=${WA_TEMPLATE_PAGAMENTO_CONFIRMADO:-}

# LLM e embeddings
LLM_BASE_URL=${LLM_BASE_URL:-}
LLM_API_KEY=${LLM_API_KEY:-}
LLM_MODEL=${LLM_MODEL:-}
EMBEDDING_MODEL=${EMBEDDING_MODEL:-}
EMBEDDING_DIM=${EMBEDDING_DIM:-1536}
LLM_PRECO_IN_POR_1M=${LLM_PRECO_IN_POR_1M:-0}
LLM_PRECO_OUT_POR_1M=${LLM_PRECO_OUT_POR_1M:-0}

# Asaas (sandbox): a chave é a mesma; o token do webhook nasce novo
ASAAS_BASE_URL=${ASAAS_BASE_URL:-https://api-sandbox.asaas.com/v3}
ASAAS_API_KEY=${ASAAS_API_KEY:-}
ASAAS_WEBHOOK_TOKEN=$(segredo | tr -d '/+=')

# Assinatura (046) e venda (045) — defaults servem; mude o que o cliente pedir
ASSINATURA_PROVIDER=${ASSINATURA_PROVIDER:-simulado}
VENDA_SINAL_CENTAVOS=${VENDA_SINAL_CENTAVOS:-200000}

# Operação
TAG=latest
DEV_SIMULATOR=true
LOG_LEVEL=info
EOF

cat >&2 <<'AVISO'

── depois de colar no Coolify, três coisas que o script NÃO faz ──
1. registrar o webhook do Asaas apontando para https://api.<dominio>/webhooks/asaas
   com o ASAAS_WEBHOOK_TOKEN acima (é chamada de API, não variável);
2. trocar o webhook do número na Meta para https://api.<dominio>/webhook — e
   REMOVER o override_callback_uri do túnel de dev, senão o dev fica sem receber;
3. rodar o seed: docker exec <server> sh /app/demo-seed.sh — sem ele o tse-sim
   sobe e não conecta (o papel dele nasce no seed) e não há usuário no console.
AVISO
