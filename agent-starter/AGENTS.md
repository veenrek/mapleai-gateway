# Agent instructions — MapleAI Agent Starter

Same content as `CLAUDE.md` — kept as a separate file for agent runtimes
that read `AGENTS.md` (OpenAI Codex, Cursor legacy, others).

## TL;DR

- API: MapleAI x402 paid LLM endpoints, USDC on Solana/Base/Polygon/Arc.
- Free entry: `POST {origin}/v1/embeddings` (2048-dim, no key).
- Paid entry: `POST {origin}/prepaid/codes/auto` — one x402 payment mints an `oms_buy_...` key
  for the cheapest combo; use it as `Authorization: Bearer` on `https://mapleai.shop/v1`.
- Key status (free): `GET https://mapleai.shop/v1/prepaid/status`.
- Chat: `POST https://mapleai.shop/v1/chat/completions` with `model` = combo name from key status.
- Live catalog/prices: `GET {origin}/v1/models`; worked examples: `GET {origin}/openapi.json`.
- Payment flow details and safety caps: see `CLAUDE.md`.
- Working paid client code: `src/scenario.mjs` (`npm run scenario -- --network base|solana`).
- Free CI smoke: `npm run smoke` (no secrets required).

## Commands

- `npm install` — install x402 client deps
- `npm run smoke` — free checks of all 4 gateways (catalog, embeddings, discovery, 402 shape)
- `npm run scenario -- --network base` — full paid path (needs `EVM_PRIVATE_KEY`)
- `npm run scenario -- --network solana` — same on Solana (needs `SVM_PRIVATE_KEY`)

## MCP

`.mcp.json` wires the `mapleai-mcp` server (tools: list_models, embed_text, prepaid_status,
chat_completion, jev_decision, buy_prepaid_tap). Keep keys in env, never in the file.
