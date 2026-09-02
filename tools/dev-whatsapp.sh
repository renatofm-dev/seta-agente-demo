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
limpar() {
  echo
  if [ -n "$TUNNEL_URL" ]; then
    echo "→ removendo o override do número (volta ao webhook do app)…"
    curl -s --max-time 20 -X POST "$GRAPH/$WA_PHONE_NUMBER_ID" \
      -H "Authorization: Bearer $WA_ACCESS_TOKEN" -H "Content-Type: application/json" \
      -d '{"webhook_configuration":{"override_callback_uri":""}}' >/dev/null || true
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
echo "Mande uma mensagem do celular e acompanhe no console: http://localhost:3000/inbox"
if [ -n "$DEV_PID" ]; then
  echo "(Ctrl+C encerra o túnel, remove o override e derruba o pnpm dev)"
else
  echo "(Ctrl+C encerra o túnel e remove o override)"
fi
wait "$TUNNEL_PID"
