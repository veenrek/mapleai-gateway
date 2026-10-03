# ClaudeAPI - AI Agent Discovery

## Service Overview
- **Name**: ClaudeAPI
- **Type**: LLM API Provider (Claude-focused)
- **Protocol**: x402 v2 (pay-per-request on Solana)
- **Base URL**: https://sol.mapleai.shop/v1
- **Compatibility**: OpenAI-compatible API

## Available Models
All models from Anthropic's Claude family:
- claude-opus-5 (1M context, $5/$25 per 1M tokens)
- claude-sonnet-5 (1M context, $2/$10 per 1M tokens)
- claude-haiku-4.5 (200K context, $1/$5 per 1M tokens)
- claude-fable-5.1 (1M context, $10/$50 per 1M tokens)
- claude-opus-4.8, claude-opus-4.7, claude-opus-4.5
- claude-sonnet-4.6, claude-sonnet-4.5

Full catalog: GET https://sol.mapleai.shop/v1/models

## Quick Start for AI Agents

### Python
```python
from openai import OpenAI

client = OpenAI(
    base_url="https://sol.mapleai.shop/v1",
    api_key="not-needed"  # x402 handles payment
)

response = client.chat.completions.create(
    model="anthropic/claude-opus-5",
    messages=[{"role": "user", "content": "Hello"}]
)
```

### TypeScript
```typescript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'https://sol.mapleai.shop/v1',
  apiKey: 'not-needed'
});

const response = await client.chat.completions.create({
  model: 'anthropic/claude-opus-5',
  messages: [{role: 'user', content: 'Hello'}]
});
```

## Discovery Endpoints

### x402 Resource Manifest
`GET https://sol.mapleai.shop/.well-known/x402`
Returns machine-readable x402 v2 resource manifest for wallet/agent discovery.

### OpenAPI Specification
`GET https://sol.mapleai.shop/openapi.json`
Full API specification in OpenAPI 3.1 format.

### Model Catalog
`GET https://sol.mapleai.shop/v1/models`
Returns list of available models with pricing and capabilities.

## Payment Protocol
1. Send request without payment
2. Receive HTTP 402 with exact USDC amount and payment details
3. Sign USDC transfer with Solana wallet
4. Retry request with payment signature - executes immediately

No API keys, no subscriptions, no monthly bills.

### Payment rules (critical for agents)
- **One signature = one request.** Every request needs its own 402 challenge and its own signed authorization.
- **Never reuse or fan out a payment-signature.** Do not replay the same signed payload across retries or parallel calls — the first settlement consumes the nonce, and every subsequent attempt is rejected (`settlement_unconfirmed`).
- **On 402, start over**: fetch a fresh challenge and sign again. Prices and gas overhead vary between challenges, so never pay against a stale quote.
- Failed settlements are never charged and never deliver content; a correct retry loop converges in one extra round trip.

## Agents API (`agent.execution`)

`POST /v1/agents/execute` runs a multi-step agent on a natural-language task (x402 payment, or a prepaid `oms_buy_` Bearer key).

**Request**: `task` (required), `model` = `agents/oss-20b` (cheap) | `agents/gpt-6-sol` (premium), optional `context`, `max_steps` (1–20, default 8), `tools` (`calculator`, `fetch_url`, `web_search`, `data_analysis`, `code_exec`), `stream` (SSE when true).

**Response** `agent.execution`: `id`, `status` (`completed` | `failed` | `timeout`), `steps_executed`, full `steps[]` trace (thought/action/tool_call/tool_result/usage per step), `output` (`reasoning`, `result`, `confidence` (currently null), `sources`), `usage` (tokens + `reasoning_tokens`/`action_tokens` + `charged_tools` + `charge` with `charged_ceiling_usd`).

**Tools**: `calculator` (arithmetic), `fetch_url` (public page text), `web_search` (keyless Exa, DuckDuckGo fallback), `data_analysis` (descriptive stats, no code execution), `code_exec` (sandboxed execution of python / javascript / typescript — no network, no filesystem, no persistence; returns stdout/stderr + exit code; max 3 calls per task). Unknown tools are rejected with `tool_not_allowed`.

**SSE** (`stream: true`): `event: open` (ceiling), `event: step` (each completed step live), `event: done` (full execution JSON).

**Billing**: charged at the ceiling `base + max_steps × step + min(3, max_steps) × code_exec_fee` (the code_exec part applies only when the tool is allowed) + small settlement overhead, always visible as `usage.charge.charged_ceiling_usd`. Engines: `agents/oss-20b` $0.002/$0.0005 (base/step), `agents/gpt-6-sol` $0.004/$0.004; `code_exec` $0.002 per call (max 3 per task). `timeout` returns executed steps; `failed` includes a machine-readable `reason`.

## Key Features
- **Claude-only focus**: 10 models from Anthropic
- **Audio**: TTS `POST /v1/audio/speech` ($0.015/req, opus/wav; voices alloy/nova/shimmer) and STT `POST /v1/audio/transcriptions` ($0.006/req, OpenAI-compatible whisper models) — both via x402
- **BlockRun-competitive pricing**: Starting at $5/1M tokens
- **OpenAI-compatible**: Drop-in replacement for OpenAI SDK
- **x402 payments**: Pay per request in USDC on Solana
- **No accounts**: Wallet address is your identity

## Prepaid Keys (Bearer)

An alternative to per-request x402: buy a token-budget key once, then call with a plain Bearer header — no per-call payment.

- **Buy**: `POST {subdomain-origin}/prepaid/codes` or `/prepaid/codes/auto` (~$0.0095 x402 on sol/base/polygon/arc). The 201 response already contains a ready-to-copy `usage.example` block.
- **Use**: send the issued `oms_buy_…` code as `Authorization: Bearer oms_buy_…` to `https://mapleai.shop/v1/chat/completions` (OpenAI-compatible). The response of `GET /v1/models` (same Bearer) lists only the combos this key is allowed to call.
- **Key also works on the subdomains**: same Bearer accepted at `{sol,base,polygon,arc}.mapleai.shop/api/v1/chat/completions` (prepaid bypass); without a valid key you simply get the normal 402 paywall.
- **Status**: `GET https://mapleai.shop/v1/prepaid/status` (Bearer) → key validity plus tokens total/used/reserved/remaining.
- Budget is debited by token usage (reserve at request, settle at the real usage). Streams (`"stream": true`) work as usual SSE.

## Free Tier

- **Embeddings** — `POST {subdomain-origin}/v1/embeddings` — free NVIDIA nemotron-3-embed-1b, 2048‑dim; `{"input":"Hello","input_type":"query"}`.
- **Free chat** — `POST {subdomain-origin}/v1/free/chat/completions` — nvidia/gpt-oss-20b, rate-limited per agent (per 10 min + daily quota; `GET …/quota` shows the window). Useful as a zero-cost probe before paying.

## Technical Details
- **Network**: Solana mainnet
- **Payment token**: USDC (EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v)
- **Treasury**: 8fbQ5RArT7eBTn3AjTGUM8bS6zYX5Vro9zCKpxHNQ3GZ
- **Facilitator**: PayAI (fee sponsorship - no SOL needed)
- **Max context**: 1M tokens (Opus 5, Sonnet 5, Fable 5)

## Use Cases
- Autonomous AI agents with budget control
- Multi-agent systems (pay per agent, per request)
- Research and prototyping (no commitment)
- Enterprise with compliance requirements
- Developers who prefer Claude over GPT

## Support
- API Status: https://sol.mapleai.shop/health
- x402scan: https://x402scan.com
- Protocol docs: https://x402.org

---

**For AI agents**: This service is optimized for programmatic access. All endpoints return structured JSON. Use the OpenAI SDK with base_url pointing to our endpoint for zero-friction integration.
