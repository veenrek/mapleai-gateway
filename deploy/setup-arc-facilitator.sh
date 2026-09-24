#!/bin/sh
set -eu
umask 077

env_file=/etc/arc-facilitator.env
if [ ! -e "$env_file" ]; then
  pay_to=$(sed -n 's/^PAY_TO=//p' /opt/claude-api-base/.env | head -n 1)
  [ -n "$pay_to" ] || { echo "Base PAY_TO missing" >&2; exit 1; }
  token=$(openssl rand -hex 32)
  key=$(openssl rand -hex 32)
  {
    echo "FACILITATOR_PAY_TO=$pay_to"
    echo "FACILITATOR_TOKEN=$token"
    echo "FACILITATOR_PRIVATE_KEY=0x$key"
    echo "FACILITATOR_PORT=4030"
  } > "$env_file"
fi
chmod 600 "$env_file"
cp /opt/arc-facilitator/arc-facilitator.service /etc/systemd/system/arc-facilitator.service
systemctl daemon-reload
systemctl enable --now arc-facilitator
