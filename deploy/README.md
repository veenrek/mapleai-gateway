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

Arc quotes add estimated settlement gas to the model price. The gateway
reads eth_gasPrice from ARC_RPC_URL (default: https://rpc.mainnet.arc.io),
assumes 125,000 gas units for transferWithAuthorization, and adds a 15%
gas-price buffer. The estimate is cached for three seconds. If the RPC
cannot supply a quote, the paid request fails closed. An old signed quote
remains valid when the new estimate falls, provided it still covers the
current model price and gas estimate; a higher estimate requires a new 402.

## Polygon gateway

The Polygon mainnet gateway runs on port 4024 at https://polygon.mapleai.shop.
It uses eip155:137, Circle's native USDC contract
0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359, the same EVM payTo as
Base, and the PayAI facilitator. Deploy with the systemd unit and setup script
in this directory. The Apache virtual hosts proxy to port 4024 and the HTTPS
host forwards X-Forwarded-Proto: https. PayAI reports exact v2 support for
eip155:137; an actual verify and settle still needs a funded Polygon payer.

## CDP facilitator

Set `FACILITATOR_MODE=cdp` and `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` on
Base, Polygon, or Solana gateway instances to use Coinbase's hosted facilitator
with the existing x402 routes and recipient wallet. This requires CDP API
credentials and does not require a CDP wallet secret. Arc (eip155:5042) is not
supported by CDP and must keep its local facilitator. The service rejects CDP
mode at startup on unsupported networks.

## Prepaid OpenAI-compatible API

The apex host `https://mapleai.shop/v1` is reserved for admin-issued prepaid
buyer keys. The Apache apex vhosts proxy `/v1/*` to the admin API and the
admin service listens on loopback only. Issue a token-budget key in
Dashboard → Marketplace → Prepaid API keys, selecting a provider or combo.
Send it as `Authorization: Bearer oms_buy_...`; `GET /v1/models` returns only
models allowed by that key. Chat Completions and Responses requests using a
combo name are routed by the combo engine and charged against the key's token
budget. Operator-issued unlimited keys can be scoped to all active combos; their
usage is tracked without a token cap. Requests without a valid prepaid key
receive `401`.

## Payment accounting

Each gateway appends paid-route events to `payment-events.jsonl` in its
working directory (or `PAYMENT_EVENTS_FILE`). Event kinds include
`payment_challenge`, `payment_rejected`, `request_failed`,
`settlement_unconfirmed` and `settled`. Only `settled` events with a
successful `PAYMENT-RESPONSE`, transaction hash and validated signed amount
count as revenue. Amounts are stored in atomic USDC units. The existing
`ledger.jsonl` is for upstream usage and quoted prices, not confirmed income.
The log stores no prompt text or payment signature.

Summarize one or more network logs with:

```sh
node tools/payment-report.mjs /opt/claude-api-*/payment-events.jsonl
```

The report deduplicates settled transaction hashes per network. Historical
ledger entries have no settlement receipt and are excluded from revenue.
