# MapleAI Agent Starter

Fork-ready starter for building paid AI agents on top of [MapleAI](https://sol.mapleai.shop) —
OpenAI-compatible LLM endpoints that charge per request in USDC via the [x402](https://www.x402.org) protocol. No accounts, no subscriptions, no API key signup: the agent's wallet is the account.

## What the agent gets out of the box

| Capability | Endpoint | Cost |
|---|---|---|
| Embeddings (2048-dim, NVIDIA nemotron-3-embed-1b) | `POST /v1/embeddings` | **Free** |
| GPT chat completions | `POST {sol,base,polygon,arc}.mapleai.shop/v1/chat/completions` | from $0.001 USDC/request |
| Responses API | `POST /v1/responses` | same |
| Image generation / edit (gpt-image-2) | `POST /api/v1/images/generations` `…/image2image` | $0.02/image |
| Jev structured decisions | `POST /jev` | $0.12/1M input tokens |
| Prepaid API key purchase (agent self-onboarding) | `POST /prepaid/codes/auto` | from $0.007 USDC |

Networks: Solana, Base, Polygon, Arc — USDC, self-custodial. Facilitators: CDP (Solana/Base/Polygon), local (Arc).

## Quickstart

```bash
git clone <this-repo>
cd mapleai-agent-starter
npm install
```

**Free tier, no keys needed:**

```bash
npm run smoke       # verifies catalog, embeddings, discovery docs
```

**Full paid scenario →** embeddings (free) → buy prepaid key (x402) → chat through the key:

```bash
# pick the network your wallet has USDC on
export SVM_PRIVATE_KEY=<base58 solana key>   # for --network solana
# or
export EVM_PRIVATE_KEY=0x...                 # for --network base

npm run scenario -- --network base
```

`scenario.mjs` buys the cheapest prepaid pack (~$0.008–0.142 depending on today's cheapest model),
verifies the key at `https://mapleai.shop/v1/prepaid/status`, then runs one chat completion
through `https://mapleai.shop/v1` — the OpenAI-compatible prepaid gateway.
The printed `oms_buy_...` key stays valid until its token budget is spent.

## MCP (local clients: Claude Code, Cursor, Claude Desktop)

`.mcp.json` in this repo wires the `mapleai-mcp` server (paid calls via your own wallet):

```json
{
  "mcpServers": {
    "mapleai": {
      "command": "npx",
      "args": ["-y", "-p", "mapleai-mcp@0.2.0", "mapleai-mcp"],
      "env": { "MCP_NETWORK": "base", "EVM_PRIVATE_KEY": "0x..." }
    }
  }
}
```

Tools: `list_models` (free), `embed_text` (free), `prepaid_status` (free),
`chat_completion`, `jev_decision`, `buy_prepaid_tap`.

## Discovery (machine-readable, agent-first)

- `GET /v1/models` — live catalog with per-model prices
- `GET /openapi.json` — full OpenAPI with worked cURL examples and payment info
- `GET /.well-known/agent-card.json` — A2A agent card (skills, interfaces, x402 security scheme)
- `GET /.well-known/x402` — x402 manifest: routes, prices, payTo, facilitator
- `GET /service-endpoints.json` — flat route index with pricing
- `GET /llms.txt`, `GET /AI-AGENTS.md` — human/LLM-readable guides

## CI

`.github/workflows/smoke.yml` runs the free smoke on every push (no secrets required).
Add `SVM_PRIVATE_KEY`/`EVM_PRIVATE_KEY` as repo secrets to unlock the optional paid smoke
(`workflow_dispatch`, ~$0.01/run, capped).

## Files

- `src/scenario.mjs` — full paid path with x402 signing
- `src/smoke.mjs` — free endpoint checks
- `CLAUDE.md` / `AGENTS.md` — repo instructions for agent clients
- `.mcp.json` — MCP server wiring
- `.env.example` — credentials template
