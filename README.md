# MapleAI — GPT, Claude and Agent APIs with x402 Pay-Per-Request

OpenAI-compatible GPT and Anthropic-native Claude chat, multi-step agent
execution, image, audio, X (Twitter) intel, embeddings and structured-decision
APIs behind one endpoint. No accounts, no subscriptions, no API keys for the
pay-per-request tier — an agent pays per call in USDC over the
[x402](https://x402.org) protocol. Prepaid API keys are available for clients
that prefer a token budget over per-request payments.

## Live endpoints

| Network | Base URL | Facilitator |
| --- | --- | --- |
| Solana | `https://sol.mapleai.shop` | Coinbase CDP |
| Base | `https://base.mapleai.shop` | Coinbase CDP |
| Polygon | `https://polygon.mapleai.shop` | Coinbase CDP |
| Arc | `https://arc.mapleai.shop` | local |

Prepaid key endpoint (shared): `https://mapleai.shop/v1`

## Models and pricing

### GPT (per 1M tokens)

| Model | Input | Output |
| --- | ---: | ---: |
| `openai/gpt-5.6-sol` | $2.80 | $14.00 |
| `openai/gpt-5.6-terra` | $1.40 | $8.40 |
| `openai/gpt-6-luna` | $0.07 | $0.35 |
| `openai/gpt-6-sol` | $1.40 | $7.00 |

A request is quoted as counted input tokens × input rate + requested output
tokens × output rate, plus the network settlement fee (about $0.001; the exact
amount is always in the 402 challenge). Failed calls (HTTP ≥ 400) are
cancelled, not settled.

### Claude (per 1M tokens)

Native Anthropic Messages API at `POST /v1/messages` (system prompt, content
blocks, SSE events, required `max_tokens`; the system prompt is billed as
input tokens). Also reachable via the OpenAI-compatible `/v1/chat/completions`.

| Model | Input | Output |
| --- | ---: | ---: |
| `anthropic/claude-haiku-4-5` | $0.50 | $2.50 |
| `anthropic/claude-sonnet-4-5`, `anthropic/claude-sonnet-4-6` | $1.50 | $7.50 |
| `anthropic/claude-sonnet-5`, `anthropic/claude-sonnet-5-5` | $1.00 | $5.00 |
| `anthropic/claude-opus-4-6`, `anthropic/claude-opus-4-7`, `anthropic/claude-opus-4-8`, `anthropic/claude-opus-5` | $2.50 | $12.50 |
| `anthropic/claude-opus-5-5` | $2.00 | $10.00 |

### Agent execution

`POST /v1/agents/execute` — multi-step agent loop (reason → call tools →
final answer), Cluster Protocol-compatible response. Optional SSE step
streaming with `"stream": true` (`step` events as tools run, `done` with the
final result). Built-in tools: deterministic `calculator`, `data_analysis`
(statistics over up to 500 numbers), keyless `web_search` (Exa) and
`fetch_url`. Per-step timeout returns partial results instead of a bare 502.

| Engine | Base | Per step | Upstream model |
| --- | ---: | ---: | --- |
| `agents/oss-20b` | $0.002 | $0.0005 | gpt-oss-20b (cheap tier) |
| `agents/gpt-6-sol` | $0.004 | $0.004 | gpt-6-sol (premium) |

Charged as a ceiling — base + `max_steps` × per-step price (+ tool ceilings),
like `max_tokens` for chat; up to 20 steps per task.

### Images (per image)

| Model | Price |
| --- | ---: |
| `gpt-image-2` | $0.02 |
| `gpt-image-2.5`, `gpt-image-2.5-flare`, `gpt-image-2.5-sunburst` | $0.04 |
| `grok-imagine-image` | $0.045 |
| `gpt-image-2-2k` | $0.09 |
| `gpt-image-2.5-sunburst-2k` | $0.22 |

`POST /api/v1/images/generations` and `POST /api/v1/images/image2image`
(edit a PNG/JPEG/WebP data URI, max 10 MB). On Solana these routes settle
upfront (image generation outlives a Solana blockhash) and retry transient
upstream failures inside the same paid request.

### Audio (per request)

| Model | Endpoint | Price |
| --- | --- | ---: |
| `tts-1`, `tts-1-hd` (Gemini flash/lite), `orpheus-english`, `orpheus-arabic` (Groq Orpheus) | `POST /v1/audio/speech` | $0.015 |
| `whisper-1` (Gemini 3.5), `whisper-large-v3`, `whisper-large-v3-turbo` (Groq) | `POST /v1/audio/transcriptions` | $0.006 |

TTS takes JSON `{model, input, voice?, response_format?}` and returns a WAV
stream; OpenAI voice presets map to Gemini voices, the orpheus models use
their own emotive voices (en: autumn/diana/hannah/austin/daniel/troy, ar:
fahad/sultan/noura/lulwa/aisha/abdullah; [laughs]-style tags and real `speed`
supported). STT takes multipart `file` + `model` or JSON base64, up to 25 MB;
`whisper-large-v3*` add `verbose_json` word timestamps and `srt`/`vtt`.
Responses carry `x-audio-upstream` and `x-fallback-used` headers — when the
primary vendor fails the request fails over to a secondary one inside the
same payment (for TTS the voice differs then).

### X (Twitter) intel

Live X search and analytics via Grok `x_search`:

| Endpoint | What it does | Price formula |
| --- | --- | --- |
| `POST /v1/x/search` | summarized answer with post citations | $0.015 + $0.0015 × `max_results` (+$0.01 with `include_web`) |
| `POST /v1/x/digest` | digest of specific handles over a look-back window | $0.02 + $0.005 × handles |
| `POST /v1/x/sentiment` | sentiment verdict, score, distribution, drivers | $0.025 + $0.0015 × evidence posts + $0.005 × days |
| `POST /v1/x/factcheck` | claim verdict with evidence for/against | $0.03 + $0.002 × sources |
| `POST /v1/x/profile` | profile dossier: bio, followers, topics, flags | $0.02 + $0.015 × handles |
| `POST /v1/x/media` | image/video understanding over post media | $0.02 + $0.002 × results |

### Jev structured decisions

`POST /jev` — `jev-latest`, $0.06 per 1M input tokens, output free. SystemOne
protocol: send `model`, `state` and named `questions` (`noul`, `choice` or
`score` with `instructions`), read `answers` from the response.

### Free tier

`POST /v1/embeddings` — free NVIDIA `nvidia/nemotron-3-embed-1b` (2048
dimensions). Send `input` as a string or an array of up to 128 strings;
`model` is optional and ignored.

`POST /v1/free/chat/completions` — free `nvidia/gpt-oss-20b` chat,
rate-limited per agent (10 requests / 10 min and 100 / day).

## Quickstart

```bash
# 1. Any request without payment returns HTTP 402 with the exact quote
curl -i https://base.mapleai.shop/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"openai/gpt-6-luna","messages":[{"role":"user","content":"Hello"}],"max_tokens":64}'

# 2. An x402-aware client signs the challenge and retries automatically
```

```typescript
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const client = new x402Client();
registerExactEvmScheme(client, { signer: privateKeyToAccount(process.env.EVM_PRIVATE_KEY) });

const first = await fetch(url, { method: "POST", headers, body });
const challenge = JSON.parse(Buffer.from(first.headers.get("payment-required"), "base64").toString());
const payment = await client.createPaymentPayload(challenge);
const paid = await fetch(url, {
  method: "POST",
  headers: { ...headers, "payment-signature": Buffer.from(JSON.stringify(payment)).toString("base64") },
  body,
});
```

A runnable end-to-end demo (free embeddings → paid GPT answer) lives in
[`examples/embeddings-to-chat/`](examples/embeddings-to-chat/) and online at
`https://base.mapleai.shop/examples/embeddings-to-chat/`.

Building an agent? Fork the [`agent-starter/`](agent-starter/) template —
repo instructions for agent clients (`CLAUDE.md`/`AGENTS.md`), MCP wiring,
a full paid scenario script (free embeddings → prepaid tap → prepaid chat),
and a free CI smoke for all four gateways.

## Prepaid API keys

Buy a prepaid bearer key for one GPT or Claude model, or a Jev input pack,
with a single x402 payment:

```bash
curl https://base.mapleai.shop/prepaid/codes \
  -H 'content-type: application/json' \
  -d '{"model":"openai/gpt-6-luna","tokens":100000}'
```

Budgets run in 100 000-token steps from 100 000 to 1 000 000, priced at the
model input rate plus the settlement fee:

| Model | 0.1M pack | 1M pack |
| --- | ---: | ---: |
| `openai/gpt-5.6-sol` | $0.28 | $2.80 |
| `openai/gpt-5.6-terra` | $0.14 | $1.40 |
| `openai/gpt-6-luna` | $0.007 | $0.07 |
| `openai/gpt-6-sol` | $0.14 | $1.40 |
| `anthropic/claude-haiku-4-5` | $0.05 | $0.50 |
| `anthropic/claude-sonnet-5` | $0.10 | $1.00 |
| `anthropic/claude-opus-5` | $0.25 | $2.50 |
| `jev-latest` (input tokens only, output free) | $0.006 | $0.06 |

GPT and Claude keys spend at `POST /prepaid/v1/chat/completions` (works on the
subdomains and at the shared `https://mapleai.shop/v1`, OpenAI-compatible);
Jev packs spend at `POST /prepaid/v1/jev`. Check usage and status for free:

```bash
curl https://mapleai.shop/v1/prepaid/status \
  -H "Authorization: Bearer oms_buy_..."
```

## Discovery

- `GET /v1/models` — free model catalog with live pricing
- `GET /.well-known/x402` — x402 resource manifest
- `GET /openapi.json` — OpenAPI 3.1 specification
- `GET /llms.txt`, `GET /AI-AGENTS.md` — agent-oriented docs
- `GET /developers` — developer guide with examples

## Repository layout

- `src/` — the x402 gateway (Express, TypeScript, runs under `tsx`)
- `admin/` — OmniRoute-based admin app: provider connections, combos,
  prepaid key issuance and wallet-only (SIWE) dashboard
- `examples/` — runnable client examples
- `packages/mapleai-mcp/` — local stdio MCP server (free model catalog, embeddings and prepaid status; paid GPT and Claude chat, Jev, agent execution and prepaid key packs with local x402 signing; bought keys spend in-server via prepaid_chat with no wallet)
- `tools/` — payment and upstream test scripts
- `deploy/` — systemd units and Apache vhosts used on the VDS

## Development

```bash
npm install
cp .env.example .env   # fill in UPSTREAM_API_KEY, PAY_TO, model prices
npm run typecheck
npm start              # listens on PORT (default 4021)
```

Required env: `UPSTREAM_API_KEY`, `PAY_TO`, `MODEL_PRICES`, `MODEL_MAPPING`.
Optional features are enabled by their own keys (`IMAGE_UPSTREAM_API_KEY`,
`NVIDIA_API_KEY`, `JEV_UPSTREAM_API_KEY`, `PREPAID_ISSUER_TOKEN`, …) — see
[`.env.example`](.env.example) for the full list.
