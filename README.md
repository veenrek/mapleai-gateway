# MapleAI — GPT and Image API with x402 Pay-Per-Request

OpenAI-compatible GPT, image, embeddings and structured-decision APIs behind one
endpoint. No accounts, no subscriptions, no API keys for the pay-per-request
tier — an agent pays per call in USDC over the [x402](https://x402.org)
protocol. Prepaid API keys are available for clients that prefer a token
budget over per-request payments.

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

### Jev structured decisions

`POST /jev` — `jev-latest`, $0.06 per 1M input tokens, output free. SystemOne
protocol: send `model`, `state` and named `questions` (`noul`, `choice` or
`score` with `instructions`), read `answers` from the response.

### Free embeddings

`POST /v1/embeddings` — free NVIDIA `nvidia/nemotron-3-embed-1b` (2048
dimensions). Send `input` as a string or an array of up to 128 strings;
`model` is optional and ignored.

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

Buy a prepaid bearer key for one GPT model with a single x402 payment:

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

The key works at `https://mapleai.shop/v1` (OpenAI-compatible). Check usage
and status for free:

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
- `packages/mapleai-mcp/` — local stdio MCP server (list models, paid chat)
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
