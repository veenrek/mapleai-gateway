#!/bin/sh
set -eu
. /etc/arc-facilitator.env
base=http://127.0.0.1:4030
auth="Authorization: Bearer $FACILITATOR_TOKEN"

curl -fsS -H "$auth" "$base/supported" | /opt/node22/bin/node -e '
let s=""; process.stdin.on("data", x => s += x).on("end", () => {
  const body = JSON.parse(s);
  if (body.kinds.length !== 1 || body.kinds[0].network !== "eip155:5042") process.exit(1);
  console.log("supported: Arc exact v2");
});'

for route in verify settle; do
  status=$(curl -sS -o /dev/null -w '%{http_code}' -H "$auth" -H 'Content-Type: application/json' -d '{"x402Version":2,"paymentPayload":{"x402Version":2,"accepted":{"network":"eip155:8453","scheme":"exact"}},"paymentRequirements":{"network":"eip155:8453","scheme":"exact"}}' "$base/$route")
  [ "$status" = 400 ] || { echo "$route: expected 400, got $status" >&2; exit 1; }
  echo "$route: foreign network rejected"
done
