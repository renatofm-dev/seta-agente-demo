#!/usr/bin/env bash
# Teste com WhatsApp REAL em dev, sem tocar no webhook de produção do app:
# sobe um quick tunnel do Cloudflare para o server local e aplica o override
# de webhook SÓ no número de teste (webhook_configuration.override_callback_uri).
#
# Uso:  pnpm dev (em outro terminal)  →  ./tools/dev-whatsapp.sh
# Sair: Ctrl+C — o script derruba o túnel e REMOVE o override (o número não
# fica apontando para uma URL morta).
#
# Requer no .env: WA_PHONE_NUMBER_ID, WA_ACCESS_TOKEN, WA_VERIFY_TOKEN.
set -euo pipefail
cd "$(dirname "$0")/.."

SERVER_URL="${SERVER_URL:-http://localhost:3001}"
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
command -v cloudflared >/dev/null || {
  echo "erro: cloudflared não instalado (brew install cloudflared)" >&2
  exit 1
}

echo "→ conferindo o server local ($SERVER_URL/healthz)…"
if ! curl -sf --max-time 5 "$SERVER_URL/healthz" >/dev/null; then
  echo "erro: server não responde — rode 'pnpm dev' em outro terminal antes" >&2
  exit 1
fi

LOG="$(mktemp -t seta-tunnel)"
cloudflared tunnel --url "$SERVER_URL" >"$LOG" 2>&1 &
TUNNEL_PID=$!

TUNNEL_URL=""
limpar() {
  echo
  if [ -n "$TUNNEL_URL" ]; then
    echo "→ removendo o override do número (volta ao webhook do app)…"
    curl -s --max-time 20 -X POST "$GRAPH/$WA_PHONE_NUMBER_ID" \
      -H "Authorization: Bearer $WA_ACCESS_TOKEN" -H "Content-Type: application/json" \
      -d '{"webhook_configuration":{"override_callback_uri":""}}' >/dev/null || true
  fi
  kill "$TUNNEL_PID" 2>/dev/null || true
  rm -f "$LOG"
  echo "→ túnel encerrado. Até a próxima!"
}
trap limpar EXIT INT TERM

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

echo "→ validando o handshake pela URL pública…"
DESAFIO="$(curl -s --max-time 25 "$TUNNEL_URL/webhook?hub.mode=subscribe&hub.verify_token=$WA_VERIFY_TOKEN&hub.challenge=12345" || true)"
if [ "$DESAFIO" != "12345" ]; then
  echo "erro: handshake não respondeu 12345 (veio: '$DESAFIO') — server/túnel com problema" >&2
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
echo "(Ctrl+C encerra o túnel e remove o override)"
wait "$TUNNEL_PID"
