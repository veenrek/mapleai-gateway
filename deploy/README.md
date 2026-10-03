# Apache reverse proxy

## Admin build backups (instant rollback)

The Next.js admin app runs from `/opt/mapleai-admin/.build/next` — losing that
directory takes the dashboard (and eventually every Node route) down, so keep
a known-good artifact on the box at all times.

- Archive a verified build BEFORE touching `.build` (rule learned 2026-10-01,
  when an interrupted command deleted the only build mid-recovery):

  ```sh
  BID=$(cat /opt/mapleai-admin/.build/next/BUILD_ID)
  mkdir -p /opt/mapleai-admin/.build-backups
  cd /opt/mapleai-admin/.build/next
  tar czf /opt/mapleai-admin/.build-backups/build-$BID-$(date +%Y%m%d-%H%M%S).tar.gz \
    BUILD_ID package.json ./*.json required-server-files.js server static
  ln -sfn build-$BID-$(date +%Y%m%d-%H%M%S).tar.gz /opt/mapleai-admin/.build-backups/latest.tar.gz
  ```

- Roll back with `/opt/mapleai-admin/rollback-build.sh [tarball]` (defaults to
  `.build-backups/latest.tar.gz`). It stops the service, restores, starts, and
  verifies health + dashboard render (~10 s downtime). Verified working
  2026-10-01.

- Builds are produced locally (Windows) and uploaded — never run `npm run build`
  on the VDS: it OOMs under the live service, and killed builds leave zombie
  `jest-worker` processes (see 2026-10-01 incident: three of them held ~300%
  CPU for 4 days). After any build attempt anywhere, `pkill -f jest-worker` to
  be sure.

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

## HTTP/2 and compression

The HTTPS vhosts enable `Protocols h2 http/1.1` and mod_deflate for JSON
responses (SSE `text/event-stream` is excluded so streaming is never
buffered). Before deploying those vhosts, enable the modules:

```sh
a2enmod http2 deflate headers
# mod_http2 does not work with mpm_prefork; switch to mpm_event if needed:
a2dismod mpm_prefork && a2enmod mpm_event
apache2ctl configtest && systemctl reload apache2
```

Only switch the MPM if `apache2ctl -M` shows `mpm_prefork_module`. mod_http2
does not run under mpm_prefork, and mod_php requires it — on the production
box PHP was therefore moved to php8.3-fpm (the vhosts proxy everything else
to Node). If the box has additional vhosts not committed to this repo,
apply the same `Protocols h2 http/1.1` and deflate blocks to them.

## CDN in front (Cloudflare)

The box is a single EU VDS; clients outside Europe pay a full RTT plus TLS
handshake per connection. Cloudflare's free tier terminates TLS at an edge
near the client, which removes most of that latency. API responses are never
cached (billing), so only the transport is fronted.

Step by step:

1. **Add the zone.** In the Cloudflare dashboard: Add site → `mapleai.shop`
   → Free plan. Cloudflare scans existing DNS records; verify they match the
   registrar's zone (all A records pointing at the VDS IP).
2. **DNS records** (Cloudflare → DNS → Records). One A record per hostname,
   all pointing at the VDS IPv4, all with proxy status **Proxied**
   (orange cloud):
   `mapleai.shop`, `sol`, `base`, `arc`, `polygon` (and `www` if used).
   Any mail records (MX/SPF/DKIM), if they ever exist, must stay
   "DNS only" (gray cloud).
3. **Switch nameservers.** Cloudflare assigns two nameservers; set them at
   the domain registrar for `mapleai.shop` (replacing the current ones) and
   wait for the zone to become Active (minutes to a few hours). Zero
   downtime: until the NS switch, traffic keeps going to the current DNS.
4. **SSL/TLS mode.** Cloudflare → SSL/TLS → Overview → set **Full (strict)**.
   Do this before relying on the zone; the default Flexible mode would talk
   plain HTTP to Apache. If the setting is locked until the zone is active,
   do it immediately after activation. The Let's Encrypt origin certificates
   keep working; certbot renewals pass through the proxy and are unaffected.

Recommended settings (same dashboard):

- SSL/TLS → Edge Certificates: **Always Use HTTPS** on, Minimum TLS 1.2,
  **Brotli** on (Speed → Optimization covers this on current dashboards),
  HTTP/2 and HTTP/3 (QUIC) are on by default on Free.
- Network: **HTTP/2 to Origin** on (Apache now speaks h2 upstream too).
- Caching → Cache Rules: create one rule — hostname in
  `mapleai.shop, *.mapleai.shop` → **Bypass cache**. POSTs and `no-store`
  responses are not cached anyway; the rule also protects SSE streams and
  any future static content with ambiguous headers.
- Security → Bots: leave **Bot Fight Mode off**. API consumers are scripts,
  and challenge/interstitial modes would break them. Keep Security level at
  Medium or lower; do not put `/v1/*` behind any challenge rule.
- WebSocket: leave enabled (irrelevant to the SSE API, harmless).

Origin hardening (optional but recommended once everything works):

1. Allow ports 80/443 only from Cloudflare ranges
   (https://www.cloudflare.com/ips, they change rarely and are announced):

   ```sh
   ufw delete allow 80,443/tcp 2>/dev/null  # adjust to existing rules
   for ip in $(curl -s https://www.cloudflare.com/ips-v4); do
     ufw allow from "$ip" to any port 80,443 proto tcp
   done
   ufw reload
   ```

2. Restore real client IPs in Apache logs (the Node apps already read
   `cf-connecting-ip`; this fixes Apache's own logs):

   ```sh
   a2enmod remoteip
   cat > /etc/apache2/conf-available/cloudflare-remoteip.conf <<'EOF'
   RemoteIPHeader CF-Connecting-IP
   RemoteIPTrustedProxyList /etc/apache2/cloudflare-ips.txt
   EOF
   curl -s https://www.cloudflare.com/ips-v4 > /etc/apache2/cloudflare-ips.txt
   curl -s https://www.cloudflare.com/ips-v6 >> /etc/apache2/cloudflare-ips.txt
   a2enconf cloudflare-remoteip && systemctl reload apache2
   ```

Verification after the NS switch:

```sh
dig +short NS mapleai.shop            # the two Cloudflare nameservers
curl -s -o /dev/null -w "%{http_version} %{response_code}\n" https://mapleai.shop/v1/health
curl -sI https://mapleai.shop/v1/health | grep -i "^server\|cf-ray"
```

Responses should show `server: cloudflare` and a `CF-RAY` header. Clients
near a Cloudflare edge then pay their TLS handshake locally instead of to
the EU box; SSE streaming passes through unbuffered.

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

The public `GET /health` and `GET /v1/health` aliases return the admin service's
lightweight liveness check (`200` when the process and SQLite respond, otherwise
`503`). They do not call model providers or require an API key.

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
