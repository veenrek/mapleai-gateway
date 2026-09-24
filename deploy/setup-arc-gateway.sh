#!/bin/sh
set -eu
umask 077

dir=/opt/claude-api-arc
mkdir -p "$dir"
if [ ! -e "$dir/.env" ]; then
  cp /opt/claude-api-base/.env "$dir/.env"
fi
sed -i 's/^PORT=.*/PORT=4023/; s/^NETWORK=.*/NETWORK=eip155:5042/; s|^FACILITATOR_URL=.*|FACILITATOR_URL=http://127.0.0.1:4030|; s|^PUBLIC_BASE_URL=.*|PUBLIC_BASE_URL=https://arc.mapleai.shop|' "$dir/.env"
token=$(sed -n 's/^FACILITATOR_TOKEN=//p' /etc/arc-facilitator.env)
if [ -z "$token" ]; then echo "Facilitator token missing" >&2; exit 1; fi
sed -i '/^FACILITATOR_TOKEN=/d' "$dir/.env"
echo "FACILITATOR_TOKEN=$token" >> "$dir/.env"
chmod 600 "$dir/.env"
cp "$dir/claude-api-arc.service" /etc/systemd/system/claude-api-arc.service
systemctl daemon-reload
systemctl enable --now claude-api-arc
