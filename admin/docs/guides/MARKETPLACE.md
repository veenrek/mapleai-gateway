---
title: "AI Token Marketplace"
version: 3.8.32
lastUpdated: 2026-06-24
---

# AI Token Marketplace

This fork adds a marketplace layer on top of OmniRoute. Sellers attach provider
accounts and publish priced models. Buyers call an OpenAI-compatible endpoint with
a marketplace buyer key.

The dashboard interface is available at `/dashboard/marketplace`.

## Tables

The schema is created by `src/lib/db/migrations/103_marketplace.sql` and accessed
through `src/lib/db/marketplace.ts`.

Core records:

- `marketplace_sellers`
- `marketplace_seller_connections`
- `marketplace_listings`
- `marketplace_buyer_keys`
- `marketplace_usage_events`
- `marketplace_ledger_entries`

## Admin Flow

Admin routes use `requireManagementAuth()`.

Create a seller:

```bash
curl -X POST http://localhost:20128/api/marketplace/sellers \
  -H "Authorization: Bearer <management-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"name":"seller-1","email":"seller@example.com"}'
```

Create a buyer key:

```bash
curl -X POST http://localhost:20128/api/marketplace/buyer-keys \
  -H "Authorization: Bearer <management-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"name":"buyer-1","balanceUsd":10}'
```

Top up a buyer key:

```bash
curl -X POST http://localhost:20128/api/marketplace/buyer-keys/<buyer-key-id>/top-up \
  -H "Authorization: Bearer <management-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"amountUsd":5}'
```

List usage events:

```bash
curl http://localhost:20128/api/marketplace/usage \
  -H "Authorization: Bearer <management-api-key>"
```

## Seller Flow

Seller routes use the seller API key returned once by `POST /api/marketplace/sellers`.

Attach an existing OmniRoute provider connection:

```bash
curl -X POST http://localhost:20128/api/marketplace/seller/connections \
  -H "Authorization: Bearer <seller-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"connectionId":"provider_connection_id"}'
```

Or create and attach an API-key provider connection:

```bash
curl -X POST http://localhost:20128/api/marketplace/seller/connections \
  -H "Authorization: Bearer <seller-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"provider":"openai","apiKey":"sk-...","name":"openai-main"}'
```

Publish a listing:

```bash
curl -X POST http://localhost:20128/api/marketplace/seller/listings \
  -H "Authorization: Bearer <seller-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"connectionId":"provider_connection_id","upstreamModel":"gpt-4o-mini","publicModel":"market/seller-1/gpt-4o-mini","inputPriceUsdPerMillionTokens":1,"outputPriceUsdPerMillionTokens":2}'
```

Read seller summary:

```bash
curl http://localhost:20128/api/marketplace/seller/summary \
  -H "Authorization: Bearer <seller-api-key>"
```

## Buyer Flow

List marketplace models:

```bash
curl http://localhost:20128/api/marketplace/v1/models \
  -H "Authorization: Bearer <buyer-api-key>"
```

Call chat completions:

```bash
curl -X POST http://localhost:20128/api/marketplace/v1/chat/completions \
  -H "Authorization: Bearer <buyer-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"model":"market/seller-1/gpt-4o-mini","messages":[{"role":"user","content":"hello"}],"max_tokens":64}'
```

Read buyer status:

```bash
curl http://localhost:20128/api/marketplace/v1/me \
  -H "Authorization: Bearer <buyer-api-key>"
```

## Prepaid Keys (anonymous users)

Prepaid keys are buyer keys with a **token budget** instead of a USD balance. The operator
issues them for users who never register: the recipient just holds the raw key and calls the
API. Typical use: "GPT, 50M tokens".

Issue (management auth, dashboard session or manage-scope key):

```bash
curl -X POST http://localhost:20128/api/marketplace/prepaid-keys \
  -H "Content-Type: application/json" \
  -d '{"name":"GPT 50M — client X","models":["market/test/gpt-5"],"tokens":50000000,"expiresInDays":365}'
```

The response contains the raw key (`oms_buy_...`) **exactly once** — it is stored hashed.

The recipient uses the same chat completions endpoint as registered buyers:

```bash
curl -X POST http://localhost:20128/api/marketplace/v1/chat/completions \
  -H "Authorization: Bearer oms_buy_..." \
  -H "Content-Type: application/json" \
  -d '{"model":"market/test/gpt-5","messages":[{"role":"user","content":"hello"}]}'
```

Public checker — no authentication, at `/check` (web page) or programmatically:

```bash
curl -X POST http://localhost:20128/api/marketplace/check-key \
  -H "Content-Type: application/json" \
  -d '{"key":"oms_buy_..."}'
```

Returns validity, model scope, tokens used/remaining, and expiry. Rate-limited per IP
(10/min); the key travels in the POST body so it never lands in access logs.

Accounting semantics for prepaid keys (`marketplace_buyer_keys.token_budget_total`):

- Reservation debits **tokens**, not USD — `reservedMicroUsd` is forced to 0, no ledger
  entries, no seller earnings (the payment happened out-of-band at issuance).
- On success, actual `total_tokens` move from `tokens_reserved` to `tokens_used`.
- On failure, the reservation is released in full.
- `expires_at` (optional) rejects the key with 401 once past.
- Exhausted budget → 402 `Insufficient prepaid tokens: <n> remaining of <total>`.

## Combo-Backed Listings

A listing can route buyer requests through an **omniroute combo** instead of a single pinned
provider connection. Create the combo first (Dashboard → Combos), then pick it in the
"Route via combo" dropdown when publishing a listing (or pass `comboId` to
`POST /api/marketplace/seller/listings`).

Behavior when a listing has `combo_id` set:

- The internal request's model is the **combo name**, so omniroute's full combo engine handles
  the request: target selection, strategy (priority / round-robin / weighted / ...), and
  fallback across the combo's targets.
- The `x-omniroute-connection` pin is **not** applied — the combo picks its own targets.
- Marketplace-level account-group failover is skipped (single target): the combo owns fallback,
  so there is no double-retry loop.
- The listing's `connection_id` remains the billing anchor: usage events and seller ledger
  entries still attribute to that seller connection.

## Accounting

Prices are stored as integer micro-USD per 1M tokens. A request reserves the
estimated maximum charge before it is sent upstream. On success, the service
uses upstream `usage` fields when present and refunds the difference. On upstream
failure, the reservation is refunded.

SSE responses stream through a `ReadableStream`; accounting finalizes when the
upstream stream closes or refunds when the stream is cancelled.

Listings can enforce `maxRequestsPerMinute` and `maxDailyTokens` at reservation
time.

When an upstream seller account returns a quota or rate-limit failure, the request
reservation is refunded for that account. If another healthy account exists in
the same seller account group, the marketplace retries the request on that
account. If every account in the group is cooling down, the listing is
temporarily hidden from buyer catalog and reservation until its cooldown expires.
Sellers can see the last error and cooldown timestamp on `/dashboard/marketplace`.

## Unified User & Wallet Authentication

A single marketplace user can both sell and buy. Identity is a crypto wallet:
the user signs a nonce with their wallet (Sign-In With Ethereum / EIP-191
`personal_sign`) and receives an httpOnly session cookie (`mkt_session`). The
schema lives in `106_marketplace_users_crypto.sql`; logic is in
`src/lib/db/marketplaceUsers.ts` and `src/lib/marketplace/crypto/`.

Login flow:

```bash
# 1. Request a nonce + the exact message to sign
curl -X POST http://localhost:20128/api/marketplace/auth/nonce \
  -H "Content-Type: application/json" \
  -d '{"wallet":"0xYourAddress"}'
# → { "nonce": "...", "issuedAt": "...", "message": "..." }

# 2. Sign `message` with personal_sign, then verify (sets the mkt_session cookie)
curl -X POST http://localhost:20128/api/marketplace/auth/verify \
  -H "Content-Type: application/json" \
  -d '{"wallet":"0xYourAddress","signature":"0x...","nonce":"...","issuedAt":"..."}'

# 3. Read the current user (balance, deposit addresses, chains)
curl http://localhost:20128/api/marketplace/wallet/me \
  -H "Cookie: mkt_session=<token>"
```

A logged-in user's seller identity and buyer keys are created on demand and
linked via `user_id`. Seller routes (`/seller/*`) accept either a seller API key
or the wallet session; `/buyer-keys` creates keys owned by the session user.

## Crypto Deposits (on-chain, chain-agnostic EVM)

Balance is topped up by sending an ERC-20 stablecoin (e.g. USDC/USDT) to a
per-user deposit address. A background watcher
(`src/shared/services/marketplaceDepositWatcher.ts`) polls each configured chain
via JSON-RPC, records `Transfer` logs to known deposit addresses, and credits the
user's wallet balance once the deposit reaches the chain's confirmation
threshold. Crediting is idempotent per `(chain_id, tx_hash, log_index)`.

Configure chains and the deposit-address master seed via environment variables:

```bash
# JSON array of chains to watch (per-chain price oracle fields are optional)
MARKETPLACE_EVM_CHAINS='[{"chainId":11155111,"name":"sepolia","rpcUrl":"https://...","tokenAddress":"0x...","tokenDecimals":6,"minConfirmations":12,"usdPerToken":1,"chainlinkFeed":"0x...","cexSymbol":"ETH-USD","priceMaxAgeSec":3600}]'
# Master seed used to derive per-user deposit addresses (keep secret)
MARKETPLACE_DEPOSIT_MNEMONIC='...'
# Optional poll interval (ms, default 60000, min 5000)
MARKETPLACE_DEPOSIT_POLL_MS=60000
# Optional CEX price cache TTL (ms, default 60000, min 5000)
MARKETPLACE_CEX_PRICE_TTL_MS=60000
```

### Price oracle (token → USD)

Deposits are priced **at credit time** (not at ingest) so the USD value reflects
the rate when the deposit settles. Per-chain resolution order
(`src/lib/marketplace/crypto/priceOracle.ts`):

1. **Chainlink** on-chain feed (`chainlinkFeed`) via `eth_call` — primary, used
   only if the answer is fresh (within `priceMaxAgeSec`, default 1h).
2. **Coinbase** spot price (`cexSymbol`, e.g. `ETH-USD`) — fallback, cached with
   a short TTL.
3. **Static `usdPerToken`** — used ONLY when neither `chainlinkFeed` nor
   `cexSymbol` is configured (operator-declared fixed-price / stablecoin token).
4. If an oracle source IS configured but all are unavailable/stale, the deposit
   is **not credited**; it stays `confirmed` and is retried next cycle. The
   service never books a wrong amount from a stale price.

When `MARKETPLACE_EVM_CHAINS` or the master seed is unset, the watcher logs
"disabled" and never starts — the rest of the marketplace works unchanged.

Deposit endpoints (require a wallet session):

```bash
# Create / fetch the deposit address for a chain
curl -X POST http://localhost:20128/api/marketplace/wallet/deposit-address \
  -H "Cookie: mkt_session=<token>" -H "Content-Type: application/json" \
  -d '{"chainId":11155111}'

# Deposit history
curl http://localhost:20128/api/marketplace/wallet/deposits -H "Cookie: mkt_session=<token>"

# Move wallet balance into a buyer key so it can be spent
curl -X POST http://localhost:20128/api/marketplace/wallet/fund-buyer-key \
  -H "Cookie: mkt_session=<token>" -H "Content-Type: application/json" \
  -d '{"buyerKeyId":"<id>","amountUsd":5}'
```

Deposit private keys are derived deterministically (HKDF-SHA256 over the master
seed + index) and stored encrypted at rest via the field-level AES-256-GCM
helper (`src/lib/db/encryption.ts`).

### Reliability & safety

- **Idempotent crediting** — a deposit is credited exactly once, keyed on
  `(chain_id, tx_hash, log_index)`.
- **Reorg reversal** — recently-credited deposits (within `reorgRecheckBlocks`
  of the head, default `max(minConfirmations*4, 64)`) are re-checked each cycle
  via `eth_getTransactionReceipt`. If the tx was dropped or reverted by a reorg,
  the credit is reversed (`crypto_deposit_reversal` ledger entry). If the funds
  were already spent, the unrecoverable remainder is logged for operator action.
- **Single-instance lock** — the watcher takes a TTL lease in `key_value` so two
  server processes sharing one database never scan/credit concurrently.
- **Rate limiting** — `/auth/nonce` and `/auth/verify` are rate-limited per
  client IP (`src/lib/marketplace/rateLimit.ts`).
- **Nonce cleanup** — expired/consumed SIWE nonces are pruned every watcher
  cycle (runs even when crypto deposits are disabled).
- **Reconciliation** — `reconcileMarketplaceUserBalances()` cross-checks each
  user's stored wallet balance against the signed sum of their user-scoped
  ledger entries; a healthy system reports zero drift.

### Not yet implemented (production gaps)

Sweep of deposited funds to a treasury wallet and seller payouts / withdrawals
are still out of scope. The token→USD price oracle (Chainlink + CEX fallback)
is implemented; a volatile deposit token is safe to enable provided its chain
entry sets `chainlinkFeed` and/or `cexSymbol`.
