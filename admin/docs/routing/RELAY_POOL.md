---
title: "Relay Pool — Upstream Account Rotation"
version: 3.8.32
lastUpdated: 2026-06-24
---

# Relay Pool — Upstream Account Rotation

Ported from the standalone **anthropic-api-relay** service (`E:\dev\relay`). The Relay Pool is an
upstream rotation layer: a pool of upstream accounts (anthropic / openai / codex) that the
`relay-pool` provider rotates through per request, with cooldowns, per-model round-robin,
converter fallbacks, and a force-try override phase.

This is the **upstream** side of the relay feature. The **downstream** side — selling access via
scoped relay tokens with rate limits — is documented in the same dashboard under
**Relay → Access Tokens** (`src/lib/db/relayProxies.ts`).

## Components

| File                                                         | Role                                                                   |
| ------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `src/lib/db/relayAccounts.ts`                                | Account store: CRUD, cooldown state machine persistence, usage, import |
| `src/lib/db/migrations/103_relay_accounts.sql`               | `relay_accounts` table                                                 |
| `open-sse/executors/relayPool.ts`                            | `RelayPoolExecutor` — phase-based rotation engine                      |
| `open-sse/executors/relayPool/anthropicOpenAI.ts`            | Anthropic ↔ OpenAI converters (request / response / SSE stream)        |
| `open-sse/executors/relayPool/codexConverter.ts`             | Codex (chatgpt.com backend) converters + JWT/refresh-token handling    |
| `src/app/api/relay/accounts/`                                | Admin API: list / create / bulk-import / patch / delete / test         |
| `src/app/(dashboard)/dashboard/relay/UpstreamPoolClient.tsx` | Dashboard UI (Relay → Upstream Pool tab)                               |

## Provider registration

`relay-pool` is registered in `APIKEY_PROVIDERS` (`src/shared/constants/providers.ts`) with
`passthroughModels: true`. The executor is registered in `open-sse/executors/index.ts` (alias
`rpool`). Requests reach it via:

- a combo target `{ provider: "relay-pool", model: "<model>" }`, or
- the direct prefix syntax `relay-pool/<model>` (also `rpool/<model>`).

The provider's upstream format is **claude** (`BaseExecutor` config `format: "claude"`), so
chatCore translates any client format to Anthropic before dispatch. The executor then converts
per account type.

## Account types

| `providerType` | Upstream format             | Request path                              | Auth header (default)  |
| -------------- | --------------------------- | ----------------------------------------- | ---------------------- |
| `anthropic`    | Claude (passthrough)        | `<baseUrl>/v1/messages`                   | `x-api-key`            |
| `openai`       | OpenAI chat (converted)     | `<baseUrl>/chat/completions`              | `authorization` Bearer |
| `codex`        | Codex Responses (converted) | `chatgpt.com/backend-api/codex/responses` | Bearer JWT             |

- **anthropic** accounts receive the request as-is (model filtering is intentionally not applied —
  the client's model id is forwarded and a model-unknown upstream 404s into rotation).- **openai** accounts get the body converted by `anthropicToOpenAI()` (tool_use ↔ tool_calls,
  tool_result ↔ role:"tool", CC system-prompt fingerprints stripped, tool-aware tail trimming via
  `OPENAI_MAX_MESSAGES`, orphan tool-result repair). Responses are converted back to Claude format
  (JSON and SSE streaming).
- **codex** accounts chain `anthropicToOpenAI` → `openAIToCodexResponses` and go through the shared
  Firefox-TLS-fingerprint client (`open-sse/services/chatgptTlsClient.ts`) because Cloudflare
  challenges default Node TLS handshakes. 401 triggers a refresh-token round-trip
  (`refreshCodexAccessToken`, `client_id` from `CODEX_CONFIG`).

An account is a rotation candidate only when `enabled = 1` AND it has usable credentials
(`apiKey` set, or a `codexRefreshToken` for codex accounts) — mirroring the standalone relay's
`isAccountAvailable()`.

## Rotation algorithm (`RelayPoolExecutor.execute`)

Phases, in order (each phase walks its accounts in order; first success wins):

1. **anthropic-sticky** — the last successful anthropic account (`active` flag), when
   `STICKY_ANTHROPIC !== "0"`.
2. **anthropic** — all anthropic accounts, reordered per-model round-robin
   (`ROUND_ROBIN_PER_MODEL`), optionally raced in parallel when `PARALLEL_ANTHROPIC !== "0"`
   (first successful response aborts the rest).
3. **openai-fallback** — top `MAX_OPENAI_FALLBACK_ACCOUNTS` openai accounts via converter.
4. **codex-fallback** — codex accounts via the converter chain.
5. **cooldown-override** — when everything else failed (or no account was available at all), ALL
   enabled family accounts are force-tried with cooldowns cleared (2 passes, 10 s pause between).
   The DB cooldown state is not modified by the override — it is a per-request view.

### Error classification

- `isAccountRelatedError()` (ported from `lib/accountRotation.js`): 401/402/403/404/429/502/529,
  quota/credits/concurrency messages, and `model_not_found`-family messages rotate to the next
  account.
- `cooldownForStatus()` — strict policy ported from the relay: **only 429 cools an account down,
  always exactly 5 s**. Transient aborts/timeouts mark the error with zero cooldown.
- A per-process recent-error TTL cache (`RECENT_ERROR_TTL_MS`, default 30 s) makes round-robin
  skip just-failed accounts.
- Client errors (e.g. 400 invalid request) are surfaced to the client immediately.

### Hold-and-retry

After all phases fail with 5xx/exhausted outcomes, the executor holds the request and re-rotates
(`RELAY_WAIT_POLL_MS`) up to `RELAY_WAIT_FOR_ACCOUNT_MS`. Provider-capacity responses
("No provider capacity") get their own retry window (`RELAY_CAPACITY_RETRY_MS`). When the retry
budget (`API_ERROR_RETRY_BUDGET`) is exhausted, a **synthetic Claude stop message** is returned
(HTTP 200, visible text) instead of hanging the client.

## Environment variables

All optional; defaults match the standalone relay.

| Variable                       | Default   | Purpose                                         |
| ------------------------------ | --------- | ----------------------------------------------- |
| `UPSTREAM_TIMEOUT_MS`          | `60000`   | Anthropic-account fetch start timeout           |
| `OPENAI_UPSTREAM_TIMEOUT_MS`   | `30000`   | OpenAI/codex-account fetch start timeout        |
| `UPSTREAM_RETRIES`             | `0`       | Intra-account retries for 429/502/504           |
| `UPSTREAM_RETRY_DELAY_MS`      | `750`     | Base delay between intra-account retries        |
| `MAX_OPENAI_FALLBACK_ACCOUNTS` | `3`       | Converter-fallback phase size                   |
| `MAX_ACCOUNTS_PER_REQUEST`     | `3`       | Anthropic-phase cap when fallback exists        |
| `STICKY_ANTHROPIC`             | `1`       | Try the last successful anthropic account first |
| `PARALLEL_ANTHROPIC`           | `1`       | Race anthropic accounts concurrently            |
| `ROUND_ROBIN_PER_MODEL`        | `1`       | Round-robin within same-`model` account groups  |
| `RECENT_ERROR_TTL_MS`          | `30000`   | Skip just-failed accounts for this long         |
| `FETCH_PHASE_DEADLINE_MS`      | `60000`   | Hard deadline per rotation phase                |
| `API_ERROR_RETRY_BUDGET`       | `3`       | Held-request retries before synthetic stop      |
| `RELAY_WAIT_FOR_ACCOUNT_MS`    | `180000`  | Total hold window for exhausted outcomes        |
| `RELAY_WAIT_POLL_MS`           | `3000`    | Poll interval while holding                     |
| `RELAY_CAPACITY_RETRY_MS`      | `20000`   | Extra window for capacity (529-style) errors    |
| `OPENAI_MAX_TOKENS`            | `4096`    | Converter max_tokens cap                        |
| `OPENAI_MAX_MESSAGES`          | `0` (off) | Converter message-count trim                    |

## Admin API

All routes require management auth (standard authz pipeline).

| Route                          | Method           | Purpose                                                                                                                                       |
| ------------------------------ | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/relay/accounts`          | GET              | List accounts (secrets stripped) + pool stats                                                                                                 |
| `/api/relay/accounts`          | POST             | Create account, or bulk-import an `accounts.json` export (raw array or `{ accounts: [...] }`) — idempotent on `(name, baseUrl, providerType)` |
| `/api/relay/accounts/:id`      | GET/PATCH/DELETE | Read / update / delete; `PATCH` accepts `clearCooldown: true`                                                                                 |
| `/api/relay/accounts/:id/test` | POST             | Probe the upstream with a tiny request; records success/error                                                                                 |

Secrets (`apiKey`, `codexRefreshToken`) are encrypted at rest via `STORAGE_ENCRYPTION_KEY`
(`src/lib/db/encryption.ts`) and never returned by the API (only an 8-char prefix).

## Usage accounting

Every success bumps `success_count`, clears cooldown, and adds `tokens_in` / `tokens_out`
(extracted from stream usage when available, length-estimated for codex without usage events).
The dashboard shows per-account and pool-wide counters.

## What was intentionally not ported

- **v0 MCP proxy** (`/mcp/v0` → `mcp.v0.dev`) — omniroute has its own MCP server; no v0 MCP
  passthrough was found in the codebase, so it was dropped.
- **Cookie-blob → JWT exchange** for codex (`exchangeCookieForJwt`) — accounts are provisioned
  with a JWT or refresh token; paste-import of session cookies was omitted.
- **Byte-size summarization** (`OPENAI_SUMMARIZE_BODY_BYTES`) of old messages — the converter keeps
  tool-aware trimming only.
- **`accounts.json` file storage** — replaced by the `relay_accounts` SQLite table.

## Tests

`tests/unit/relay-pool.test.ts` — DB CRUD + encryption-at-rest, import idempotency, rotation error
classification, cooldown policy, and all converter directions.

```bash
node --import tsx/esm --test tests/unit/relay-pool.test.ts
```
