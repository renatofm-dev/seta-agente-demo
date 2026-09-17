#!/usr/bin/env bash
# Teste com WhatsApp REAL em dev, sem tocar no webhook de produção do app:
# sobe um quick tunnel do Cloudflare para o server local e aplica o override
# de webhook SÓ no número de teste (webhook_configuration.override_callback_uri).
#
# Uso:  pnpm dev-whatsapp   (ou ./tools/dev-whatsapp.sh)
#       Se o server não estiver de pé, o script sobe o `pnpm dev` (Postgres +
#       tsc watch + server + console) neste mesmo terminal e espera o healthz.
#       Com o `pnpm dev` já rodando em outro terminal, só faz o túnel.
# Sair: Ctrl+C — derruba o túnel, REMOVE o override (o número não fica
#       apontando para uma URL morta) e encerra o `pnpm dev` que ele subiu.
#
# Requer no .env: WA_PHONE_NUMBER_ID, WA_ACCESS_TOKEN, WA_VERIFY_TOKEN.
set -euo pipefail
cd "$(dirname "$0")/.."

GRAPH="https://graph.facebook.com/v21.0"

if [ ! -f .env ]; then
  echo "erro: .env não encontrado na raiz do repo" >&2
  exit 1
fi
set -a
# shellcheck disable=SC1091
. ./.env
set +a
: "${WA_PHONE_NUMBER_ID:?falta WA_PHONE_NUMBER_ID no .env}"
: "${WA_ACCESS_TOKEN:?falta WA_ACCESS_TOKEN no .env}"
: "${WA_VERIFY_TOKEN:?falta WA_VERIFY_TOKEN no .env}"
SERVER_PORT="${PORT:-3001}"
CONSOLE_PORT=3000
SERVER_URL="${SERVER_URL:-http://localhost:$SERVER_PORT}"
command -v cloudflared >/dev/null || {
  echo "erro: cloudflared não instalado (brew install cloudflared)" >&2
  exit 1
}

DEV_PID=""
TUNNEL_PID=""
TUNNEL_URL=""
LOG=""
ASAAS_WEBHOOK_ID=""
ASAAS_BASE="${ASAAS_BASE_URL:-https://api-sandbox.asaas.com/v3}"
asaas() { # método, path, [corpo]
  if [ -n "${3:-}" ]; then
    curl -s --max-time 20 -X "$1" "$ASAAS_BASE$2" -H "access_token: ${ASAAS_API_KEY:-}" \
      -H "User-Agent: seta-agente/dev" -H "Content-Type: application/json" -d "$3"
  else
    curl -s --max-time 20 -X "$1" "$ASAAS_BASE$2" -H "access_token: ${ASAAS_API_KEY:-}" \
      -H "User-Agent: seta-agente/dev"
  fi
}

# Acha o `seta-dev` pelo NOME, na conta. Existe porque depender de uma variável
# deste processo só funciona quando o processo termina direito — e o caso que
# interessa é justamente o contrário (terminal fechado, kill -9, túnel subido
# por fora). Imprime "id url enabled" ou nada.
asaas_seta_dev() {
  [ -n "${ASAAS_API_KEY:-}" ] || return 0
  asaas GET '/webhooks?limit=100' 2>/dev/null | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
w = next((w for w in d.get("data", []) if w.get("name") == "seta-dev"), None)
if w:
    print(w.get("id", ""), w.get("url", ""), str(w.get("enabled", False)).lower())
' 2>/dev/null || true
}
limpar() {
  echo
  if [ -n "$TUNNEL_URL" ]; then
    echo "→ removendo o override do número (volta ao webhook do app)…"
    curl -s --max-time 20 -X POST "$GRAPH/$WA_PHONE_NUMBER_ID" \
      -H "Authorization: Bearer $WA_ACCESS_TOKEN" -H "Content-Type: application/json" \
      -d '{"webhook_configuration":{"override_callback_uri":""}}' >/dev/null || true
  fi
  # 014: a URL do quick tunnel morre junto — webhook ligado apontaria para o nada.
  # Procura por NOME em vez de usar $ASAAS_WEBHOOK_ID: se o registro falhou no
  # meio, ou se uma sessão anterior morreu sem rodar este trap, o webhook velho
  # ainda está ligado e é ele que precisa ser desligado.
  ASAAS_LIMPAR_ID="$ASAAS_WEBHOOK_ID"
  if [ -z "$ASAAS_LIMPAR_ID" ]; then
    ASAAS_LIMPAR_ID="$(asaas_seta_dev | awk '{print $1}')"
  fi
  if [ -n "$ASAAS_LIMPAR_ID" ]; then
    echo "→ desligando o webhook do Asaas (seta-dev)…"
    asaas PUT "/webhooks/$ASAAS_LIMPAR_ID" '{"enabled":false}' >/dev/null || true
  fi
  [ -n "$TUNNEL_PID" ] && kill "$TUNNEL_PID" 2>/dev/null || true
  [ -n "$LOG" ] && rm -f "$LOG" || true
  if [ -n "$DEV_PID" ]; then
    echo "→ encerrando o pnpm dev (tsc, server, console)…"
    # grupo de processos inteiro: só o pid do pnpm deixaria server/next órfãos nas portas.
    kill -- -"$DEV_PID" 2>/dev/null || kill "$DEV_PID" 2>/dev/null || true
    wait "$DEV_PID" 2>/dev/null || true
  fi
  if [ -n "$TUNNEL_PID" ]; then echo "→ túnel encerrado. Até a próxima!"; fi
}
trap limpar EXIT
trap 'exit 0' INT
trap 'exit 143' TERM

# Sobra de sessão anterior: um `seta-dev` LIGADO apontando para um túnel que já
# morreu. O Asaas entrega SEQUENTIALLY, então o primeiro evento que falha segura
# todos os seguintes — e ele avisa por e-mail antes de suspender o webhook. Se o
# registro abaixo for rodar, ele reaponta sozinho; se não for (sem chave, sem
# e-mail), pelo menos quem está no terminal fica sabendo.
ASAAS_SOBRA="$(asaas_seta_dev)"
if [ -n "$ASAAS_SOBRA" ]; then
  SOBRA_URL="$(printf '%s' "$ASAAS_SOBRA" | awk '{print $2}')"
  SOBRA_ON="$(printf '%s' "$ASAAS_SOBRA" | awk '{print $3}')"
  if [ "$SOBRA_ON" = "true" ]; then
    echo "aviso: webhook 'seta-dev' do Asaas está LIGADO em $SOBRA_URL" >&2
    echo "       (sobra de uma sessão que não encerrou direito; será reapontado)" >&2
  fi
fi

echo "→ conferindo o server local ($SERVER_URL/healthz)…"
if ! curl -sf --max-time 5 "$SERVER_URL/healthz" >/dev/null; then
  # Preflight: porta ocupada por outra coisa faz o Next/server subirem torto
  # (ex.: 3000 presa ⇒ Next cairia na 3001 e o server morreria com EADDRINUSE,
  # e todo GET no túnel viraria 404 do Next).
  for porta in "$SERVER_PORT" "$CONSOLE_PORT"; do
    # lsof devolve 1 quando não acha nada: `|| true` pra não tropeçar no pipefail.
    DONO="$( (lsof -nP -iTCP:"$porta" -sTCP:LISTEN 2>/dev/null || true) | awk 'NR>1{print $1" (pid "$2")"}' | sort -u | tr '\n' ' ')"
    if [ -n "$DONO" ]; then
      echo "erro: porta $porta já está em uso por: $DONO" >&2
      echo "       libere a porta (kill <pid>) ou pare o processo e rode de novo." >&2
      exit 1
    fi
  done
  echo "→ server não está de pé — subindo 'pnpm dev' aqui mesmo…"
  # set -m: pnpm dev vira grupo de processos próprio (pra derrubar tudo no Ctrl+C).
  set -m
  pnpm dev </dev/null &
  DEV_PID=$!
  set +m
  # docker --wait + tsc -b + migrate + boot do server: dá até 3 min.
  for _ in $(seq 1 90); do
    curl -sf --max-time 5 "$SERVER_URL/healthz" >/dev/null && break
    if ! kill -0 "$DEV_PID" 2>/dev/null; then
      echo "erro: 'pnpm dev' morreu antes do server responder (veja o log acima)" >&2
      exit 1
    fi
    sleep 2
  done
  if ! curl -sf --max-time 5 "$SERVER_URL/healthz" >/dev/null; then
    echo "erro: server não respondeu em $SERVER_URL/healthz após 3 min" >&2
    exit 1
  fi
  echo "→ server de pé."
fi

LOG="$(mktemp -t seta-tunnel)"
cloudflared tunnel --url "$SERVER_URL" >"$LOG" 2>&1 &
TUNNEL_PID=$!

echo "→ esperando a URL do túnel…"
for _ in $(seq 1 30); do
  TUNNEL_URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1 || true)"
  [ -n "$TUNNEL_URL" ] && break
  sleep 2
done
if [ -z "$TUNNEL_URL" ]; then
  echo "erro: cloudflared não publicou a URL (veja o log):" >&2
  tail -5 "$LOG" >&2
  exit 1
fi
echo "  túnel: $TUNNEL_URL"
# A URL sai no log ANTES do túnel registrar e do DNS publicar o nome. Consultar
# o nome cedo demais faz o resolver (operadora/macOS) cachear NXDOMAIN por
# minutos e o handshake falha em série. Então: espera registrar, e valida
# fixando o IP anycast da Cloudflare (--resolve) em vez de depender do DNS local
# — a Meta chega pelo DNS dela; o resolver desta máquina não importa.
echo "→ esperando o túnel registrar na Cloudflare…"
for _ in $(seq 1 30); do
  grep -q 'Registered tunnel connection' "$LOG" && break
  sleep 1
done
TUNNEL_HOST="${TUNNEL_URL#https://}"
CF_IP="$(dig +short +time=3 @1.1.1.1 trycloudflare.com A 2>/dev/null | grep -m1 -E '^[0-9.]+$' || true)"
[ -n "$CF_IP" ] || CF_IP="$(dig +short +time=3 trycloudflare.com A 2>/dev/null | grep -m1 -E '^[0-9.]+$' || true)"
CURL_PUB=(curl -s --max-time 15)
[ -n "$CF_IP" ] && CURL_PUB+=(--resolve "$TUNNEL_HOST:443:$CF_IP")

HANDSHAKE="webhook?hub.mode=subscribe&hub.verify_token=$WA_VERIFY_TOKEN&hub.challenge=12345"
echo "→ validando o handshake no server local…"
DESAFIO="$(curl -s --max-time 10 "$SERVER_URL/$HANDSHAKE" || true)"
if [ "$DESAFIO" != "12345" ]; then
  echo "erro: o server local não respondeu 12345 ao handshake (veio: '${DESAFIO:0:200}')" >&2
  echo "       o WA_VERIFY_TOKEN do .env é o mesmo que o server carregou? (reinicie o pnpm dev)" >&2
  exit 1
fi
echo "→ validando o handshake pela URL pública (via ${CF_IP:-DNS local})…"
DESAFIO=""
for _ in $(seq 1 20); do
  DESAFIO="$("${CURL_PUB[@]}" "$TUNNEL_URL/$HANDSHAKE" || true)"
  [ "$DESAFIO" = "12345" ] && break
  sleep 3
done
if [ "$DESAFIO" != "12345" ]; then
  echo "erro: handshake pela URL pública não respondeu 12345 em ~60s (veio: '${DESAFIO:0:200}')" >&2
  echo "       log do cloudflared:" >&2; grep -E 'ERR|WRN' "$LOG" | tail -5 >&2 || true
  exit 1
fi

echo "→ aplicando o override no número de teste…"
RESPOSTA="$(curl -s --max-time 30 -X POST "$GRAPH/$WA_PHONE_NUMBER_ID" \
  -H "Authorization: Bearer $WA_ACCESS_TOKEN" -H "Content-Type: application/json" \
  -d '{"webhook_configuration":{"override_callback_uri":"'"$TUNNEL_URL"'/webhook","verify_token":"'"$WA_VERIFY_TOKEN"'"}}')"
if ! printf '%s' "$RESPOSTA" | grep -q '"success":true'; then
  echo "erro ao aplicar override: $RESPOSTA" >&2
  exit 1
fi

DESTINO="$(curl -s --max-time 25 "$GRAPH/$WA_PHONE_NUMBER_ID?fields=webhook_configuration,display_phone_number" \
  -H "Authorization: Bearer $WA_ACCESS_TOKEN")"
echo
echo "✔ pronto — webhooks do número de teste chegam no seu server local."
printf '%s\n' "$DESTINO" | python3 -m json.tool 2>/dev/null || printf '%s\n' "$DESTINO"
echo
# 014: webhook do Asaas pelo mesmo túnel (só com a chave e o token no .env). Best-effort:
# falha aqui não derruba o teste do WhatsApp — o pagamento só não confirma sozinho.
if [ -n "${ASAAS_API_KEY:-}" ] && [ -n "${ASAAS_WEBHOOK_TOKEN:-}" ]; then
  if [ -z "${ASAAS_WEBHOOK_EMAIL:-}" ]; then
    echo "aviso: ASAAS_WEBHOOK_EMAIL ausente no .env — webhook do Asaas NÃO registrado" >&2
  else
    echo "→ registrando o webhook do Asaas ($ASAAS_BASE) → $TUNNEL_URL/webhooks/asaas…"
    ASAAS_WEBHOOK_ID="$(asaas GET '/webhooks?limit=100' | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    d = {}
print(next((w["id"] for w in d.get("data", []) if w.get("name") == "seta-dev"), ""))' 2>/dev/null || true)"
    CORPO_WEBHOOK="$(python3 -c '
import json, sys
print(json.dumps({
  "name": "seta-dev", "url": sys.argv[1] + "/webhooks/asaas", "email": sys.argv[2],
  "enabled": True, "interrupted": False, "apiVersion": 3, "authToken": sys.argv[3],
  "sendType": "SEQUENTIALLY",
  "events": ["PAYMENT_CREATED", "PAYMENT_CONFIRMED", "PAYMENT_RECEIVED", "PAYMENT_OVERDUE",
             "PAYMENT_DELETED", "PAYMENT_REFUNDED", "PAYMENT_RECEIVED_IN_CASH_UNDONE"]}))' \
      "$TUNNEL_URL" "$ASAAS_WEBHOOK_EMAIL" "$ASAAS_WEBHOOK_TOKEN")"
    if [ -n "$ASAAS_WEBHOOK_ID" ]; then
      RESP_ASAAS="$(asaas PUT "/webhooks/$ASAAS_WEBHOOK_ID" "$CORPO_WEBHOOK" || true)"
    else
      RESP_ASAAS="$(asaas POST '/webhooks' "$CORPO_WEBHOOK" || true)"
      ASAAS_WEBHOOK_ID="$(printf '%s' "$RESP_ASAAS" | python3 -c 'import sys,json
try: print(json.load(sys.stdin).get("id",""))
except Exception: print("")' 2>/dev/null || true)"
    fi
    if [ -n "$ASAAS_WEBHOOK_ID" ] && printf '%s' "$RESP_ASAAS" | grep -q '"enabled":true'; then
      echo "  webhook Asaas seta-dev: $ASAAS_WEBHOOK_ID ✔ (desligado no Ctrl+C)"
    else
      echo "aviso: não consegui registrar o webhook do Asaas: ${RESP_ASAAS:0:300}" >&2
      ASAAS_WEBHOOK_ID=""
    fi
  fi
else
  echo "(sem ASAAS_API_KEY/ASAAS_WEBHOOK_TOKEN no .env: PSP simulado, sem webhook)"
fi

echo "Mande uma mensagem do celular e acompanhe no console: http://localhost:3000/inbox"
if [ -n "$DEV_PID" ]; then
  echo "(Ctrl+C encerra o túnel, remove o override e derruba o pnpm dev)"
else
  echo "(Ctrl+C encerra o túnel e remove o override)"
fi
wait "$TUNNEL_PID"
