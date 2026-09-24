KEY="[redacted]"
echo "--- models (5 tries) ---"
for i in 1 2 3 4 5; do
  R=$(curl -s --max-time 20 https://www.nexotoken.net/v1/models -H "Authorization: Bearer $KEY")
  echo "try $i: $(echo "$R" | head -c 150)"
done
echo "--- chat x10 ---"
ok=0
for i in $(seq 1 10); do
  R=$(curl -s --max-time 60 https://www.nexotoken.net/v1/chat/completions -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"model":"gpt-5.6-sol","messages":[{"role":"user","content":"hi"}]}')
  case "$R" in *choices*) ok=$((ok+1)); echo "  try $i OK";; esac
done
echo "VPS chat ok: $ok/10"
