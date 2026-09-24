#!/bin/sh
set -eu
umask 077

dir=/opt/claude-api-polygon
mkdir -p "$dir"
if [ ! -e "$dir/.env" ]; then
  cp /opt/claude-api-base/.env "$dir/.env"
fi
sed -i 's/^PORT=.*/PORT=4024/; s/^NETWORK=.*/NETWORK=eip155:137/; s|^FACILITATOR_URL=.*|FACILITATOR_URL=https://facilitator.payai.network|; s|^PUBLIC_BASE_URL=.*|PUBLIC_BASE_URL=https://polygon.mapleai.shop|' "$dir/.env"
sed -i '/^FACILITATOR_TOKEN=/d; /^PAYMENT_ASSET_ADDRESS=/d' "$dir/.env"
chmod 600 "$dir/.env"
cp "$dir/claude-api-polygon.service" /etc/systemd/system/claude-api-polygon.service
systemctl daemon-reload
systemctl enable --now claude-api-polygon
