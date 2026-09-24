# Apache reverse proxy

The gateway uses Express `trust proxy`. The x402 Express adapter builds
`PaymentRequired.resource.url` from the request protocol and host.

For each HTTPS virtual host that proxies to the gateway, preserve the host and
forward the external protocol:

`apache
ProxyPreserveHost On
RequestHeader set X-Forwarded-Proto https
ProxyPass / http://127.0.0.1:4021/
ProxyPassReverse / http://127.0.0.1:4021/
`

Use port 4022 for the Base instance. Verify with `apache2ctl configtest`
before reloading Apache. Without `X-Forwarded-Proto`, x402 advertises an
`http://` resource URL even when the public request used HTTPS, and Bazaar
discovery rejects the payment challenge.

## Arc facilitator

The Arc facilitator runs on 127.0.0.1:4030 through the systemd unit in
deploy/arc-facilitator.service. Set FACILITATOR_PAY_TO, FACILITATOR_TOKEN,
and FACILITATOR_PRIVATE_KEY in /etc/arc-facilitator.env (mode 0600). Its
preflight checks chain ID 5042 and the Arc USDC EIP-3009 token metadata.
The Arc gateway uses FACILITATOR_URL=http://127.0.0.1:4030 and the same
FACILITATOR_TOKEN. Do not expose the facilitator port publicly.

The signer needs Arc USDC for gas before a real settlement can work. The
gateway must use NETWORK=eip155:5042, the configured recipient, and a
separate local port. Robinhood Chain needs a verified USDC token before
payment support can be enabled there.
