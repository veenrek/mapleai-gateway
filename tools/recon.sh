#!/bin/bash
for d in /opt/claude-api-sol /opt/claude-api-base; do
  echo "===== $d ====="
  echo "--- public ---"
  ls -la "$d/public" 2>&1
  echo "--- src ---"
  ls -la "$d/src" 2>&1
  echo "--- root ---"
  ls -la "$d" 2>&1 | head -30
  echo "--- .env (keys masked) ---"
  sed -E 's/(KEY|TOKEN|SECRET)=.*/\1=<masked>/' "$d/.env" 2>&1
  echo "--- git? ---"
  if [ -d "$d/.git" ]; then echo "git present"; git -C "$d" log --oneline 2>&1 | head -5; else echo "NO GIT"; fi
done
echo "===== live checks ====="
for h in sol.mapleai.shop base.mapleai.shop; do
  echo "--- $h ---"
  echo -n "favicon: "; curl -s -o /dev/null -w '%{http_code} %{content_type} %{size_download}\n' "https://$h/favicon.ico"
  echo -n "health:  "; curl -s -o /dev/null -w '%{http_code}\n' "https://$h/health"
  echo -n "brand:   "; curl -s "https://$h/" | grep -oE '<span>[^<]*</span>' | head -3
  echo -n "price:   "; curl -s "https://$h/" | grep -oE 'from \$[0-9.]+' | head -2
  echo -n "title:   "; curl -s "https://$h/openapi.json" | head -c 200; echo
  echo -n "responses api: "; curl -s -o /dev/null -w '%{http_code}\n' -X POST "https://$h/api/v1/responses" -H 'content-type: application/json' -d '{"model":"claude-sonnet-5","input":"hi"}'
  echo -n "api chat: "; curl -s -o /dev/null -w '%{http_code}\n' -X POST "https://$h/api/v1/chat/completions" -H 'content-type: application/json' -d '{"model":"claude-sonnet-5","messages":[{"role":"user","content":"hi"}]}'
done
