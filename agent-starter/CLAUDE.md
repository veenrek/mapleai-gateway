# MapleAI Agent Starter — instructions for agent clients

You are working in a starter repo for agents that consume the MapleAI paid LLM API.
Read this before touching code.

## What MapleAI is

OpenAI-compatible LLM endpoints monetized per request in USDC via x402 (HTTP 402).
Four networks: Solana, Base, Polygon, Arc. No accounts: the caller's wallet is the identity.

- Origins: `https://{sol,base,polygon,arc}.mapleai.shop`
- Prepaid gateway (bearer `oms_buy_...` keys): `https://mapleai.shop/v1`

## Payment model (x402 v2)

1. POST a paid endpoint → `402` with base64 `PAYMENT-REQUIRED` challenge
   (`x402Version: 2`, accepts: scheme `exact`, network CAIP-2, USDC asset, `payTo` recipient, atomic amount).
2. Sign the payload with the local wallet (`@x402/core` client — see `src/scenario.mjs` for a full working example).
3. Retry with `PAYMENT-SIGNATURE` header → `200` + base64 `PAYMENT-RESPONSE` (settlement receipt with tx hash).
4. On handler errors (4xx/5xx) after payment, settlement is cancelled — the client is not charged.

Always validate before signing: `scheme === "exact"`, expected network, expected asset, `payTo` matches the catalog, amount within your cap (`spendCapAtoms` in `src/scenario.mjs`).

## Endpoints you will use most

- `POST /v1/embeddings` — **free**, 2048-dim vectors, `input` = string or 1..128 strings.
  Optional fields: `input_type` (`query`|`passage`), `encoding_format`. `model` is ignored (single fixed model).
- `POST /v1/chat/completions`, `POST /v1/responses` — GPT models, priced per counted tokens + overhead. Prices live in `GET /v1/models`.
- `POST /jev` — structured decisions (`model: jev-latest`, `state`, `questions`).
- `POST /prepaid/codes {model, tokens}` — prepaid key pack (100k..1M tokens in 0.1M steps).
- `POST /prepaid/codes/auto` — empty body buys the cheapest current pack ("tap").
- `GET https://mapleai.shop/v1/prepaid/status` — free key status (`valid`, `remaining`).

## Discovery before hardcoding anything

Fetch these instead of guessing — they are regenerated from live config:

- `GET /v1/models` — sellable models + prices (models can drop out during upstream incidents).
- `GET /openapi.json` — worked cURL examples (`x-worked-example`) per route.
- `GET /service-endpoints.json` — flat route/pricing index.
- `GET /.well-known/agent-card.json` — A2A skills card.
- `GET /llms.txt`, `GET /AI-AGENTS.md` — prose guides.
- `GET /health` — degraded models appear here (`degradedModels`).

## Hygiene rules

- Never commit private keys. `.env` is gitignored; use env vars only.
- `SVM_PRIVATE_KEY` (base58) for Solana, `EVM_PRIVATE_KEY` (0x…) for Base.
- Keep per-payment caps small; this starter caps at 1.00 USDC.
- Free endpoints (embeddings, models, status) need no payment and no auth — use them for retries/health probes instead of burning paid calls.
- If a model disappears from the catalog, switch to `statusData.allowedModels[0]`-style discovery instead of a hardcoded fallback.
