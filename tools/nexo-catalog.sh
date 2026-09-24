#!/bin/bash
# Probe nexotoken catalog + per-model availability from the VPS.
KEY="$1"
BASE="https://www.nexotoken.net/v1"
echo "=== GET /v1/models ==="
curl -s --max-time 30 "$BASE/models" -H "Authorization: Bearer $KEY" -o /tmp/nexo-models.json -w 'http=%{http_code}\n'
python3 - <<'PY'
import json
try:
    d = json.load(open('/tmp/nexo-models.json'))
except Exception as e:
    print('parse fail', e); raise SystemExit
ids = [m.get('id') for m in d.get('data', [])]
print('count =', len(ids))
for i in sorted(ids):
    print(' -', i)
PY
echo
echo "=== POST /v1/chat/completions per model ==="
for m in $(python3 -c "import json;d=json.load(open('/tmp/nexo-models.json'));print(' '.join(sorted(m['id'] for m in d.get('data',[]))))" 2>/dev/null); do
  code=$(curl -s --max-time 60 "$BASE/chat/completions" \
    -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
    -d "{\"model\":\"$m\",\"messages\":[{\"role\":\"user\",\"content\":\"say ok\"}],\"max_tokens\":16,\"stream\":false}" \
    -o /tmp/nexo-one.json -w '%{http_code}')
  snippet=$(head -c 220 /tmp/nexo-one.json | tr -d '\n')
  echo "[$code] $m :: $snippet"
done
