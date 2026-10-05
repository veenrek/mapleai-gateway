# MapleAI → Tenjin shelf proposal

Payload for onboarding MapleAI as a provider on the Tenjin shelf
(`POST /api/x402-router` capability records). Field names follow the
Tenjin router vocabulary from https://tenjin.sh/llms-full.txt:
`capabilityId`, `category`, `provider`, `capabilityDescription`, `endpoint`,
`providerPriceAtomic` (USDC atomic units, 6 decimals, on Base eip155:8453),
`contract.request` (verbatim call), `resultSchema`.

Provider meta (shared)

- `provider`: MapleAI
- `network`: `eip155:8453` (Base), USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
- Also live on: `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`, `eip155:137`, `eip155:5042`
- Discovery: `https://base.mapleai.shop/service-endpoints.json`,
  `https://base.mapleai.shop/openapi.json`, `https://base.mapleai.shop/.well-known/agent-card.json`
- Proof it already works for Tenjin agents: 212 settled paid calls to
  `POST https://base.mapleai.shop/jev` on 2026-09-29 over ~3h, 100% HTTP 200,
  payer `0x3200E728f87Be178b6FD289694F360ffeAC2BB38`, UA `tenjin-cli/0.1.0-alpha.19`.

---

## 1. jev — structured decisions (already proven with Tenjin CLI)

```json
{
  "capabilityId": "mapleai-jev",
  "category": "classification",
  "provider": "MapleAI",
  "capabilityDescription": "Structured decisions via Jev (SystemOne): name a set of yes/no (noul), choice, or score questions with plain-language instructions, pass any state (text, code snippets, evidence objects), get calibrated 0..1 scores per question. Ideal for relevance gating, triage, routing.",
  "endpoint": "https://base.mapleai.shop/jev",
  "providerPriceAtomic": "1004 + $0.06/1M input tokens (~1928 typical)",
  "contract": {
    "request": {
      "url": "https://base.mapleai.shop/jev",
      "method": "POST",
      "headers": { "content-type": "application/json" },
      "body": {
        "model": "jev-latest",
        "state": "<text or JSON string with the evidence>",
        "questions": {
          "billing": { "type": "noul", "instructions": "Is this about a billing issue?" }
        }
      }
    },
    "resultSchema": {
      "type": "object",
      "required": ["answers"],
      "properties": {
        "model": { "type": "string" },
        "answers": { "type": "object", "description": "per-question {type, noul|choice|score}" },
        "usage": { "type": "object", "properties": { "input_tokens": {"type":"integer"}, "output_tokens": {"type":"integer"} } }
      }
    }
  }
}
```

## 2. gpt-chat — cheap GPT chat

```json
{
  "capabilityId": "mapleai-gpt-chat",
  "category": "text",
  "provider": "MapleAI",
  "capabilityDescription": "OpenAI-compatible chat completions. Models (live catalog at GET /v1/models): gpt-5.6-sol $2.8/1M in, gpt-5.6-terra $1.4/1M in, gpt-6-sol $1.4/1M in, gpt-6-luna $0.07/1M in. Short answers cost ~0.1 US cent.",
  "endpoint": "https://base.mapleai.shop/v1/chat/completions",
  "providerPriceAtomic": "from 1004 per request",
  "contract": {
    "request": {
      "url": "https://base.mapleai.shop/v1/chat/completions",
      "method": "POST",
      "headers": { "content-type": "application/json" },
      "body": {
        "model": "openai/gpt-6-luna",
        "messages": [{ "role": "user", "content": "<prompt>" }],
        "max_tokens": 256
      }
    },
    "resultSchema": { "$ref": "OpenAI chat.completion" }
  }
}
```

## 3. gpt-responses — OpenAI Responses API

```json
{
  "capabilityId": "mapleai-gpt-responses",
  "category": "text",
  "provider": "MapleAI",
  "capabilityDescription": "OpenAI Responses API shape (output_text + usage), same models and prices as gpt-chat. Use when the agent already speaks the Responses API.",
  "endpoint": "https://base.mapleai.shop/v1/responses",
  "providerPriceAtomic": "from 1004 per request",
  "contract": {
    "request": {
      "url": "https://base.mapleai.shop/v1/responses",
      "method": "POST",
      "headers": { "content-type": "application/json" },
      "body": { "model": "openai/gpt-6-luna", "input": "<prompt>", "max_output_tokens": 256 }
    },
    "resultSchema": { "$ref": "OpenAI response object" }
  }
}
```

## 4. image-generate — gpt-image-2

```json
{
  "capabilityId": "mapleai-image-generate",
  "category": "image",
  "provider": "MapleAI",
  "capabilityDescription": "Text-to-image with gpt-image-2 (also gpt-image-2.5 family and grok-imagine). Returns URL or b64_json. Base size 1024x1024, 2K variants available.",
  "endpoint": "https://base.mapleai.shop/api/v1/images/generations",
  "providerPriceAtomic": "22500 (gpt-image-2 1024x1024 incl. Base fee)",
  "contract": {
    "request": {
      "url": "https://base.mapleai.shop/api/v1/images/generations",
      "method": "POST",
      "headers": { "content-type": "application/json" },
      "body": { "model": "gpt-image-2", "prompt": "<description>", "size": "1024x1024", "n": 1 }
    },
    "resultSchema": { "type": "object", "required": ["data"], "properties": { "data": { "type": "array" } } }
  }
}
```

## 5. image-edit — gpt-image-2 img2img

```json
{
  "capabilityId": "mapleai-image-edit",
  "category": "image",
  "provider": "MapleAI",
  "capabilityDescription": "Image-to-image edit with gpt-image-2: pass a source image URL and an edit instruction, get an edited PNG.",
  "endpoint": "https://base.mapleai.shop/api/v1/images/image2image",
  "providerPriceAtomic": "22500 (1024x1024 incl. Base fee)",
  "contract": {
    "request": {
      "url": "https://base.mapleai.shop/api/v1/images/image2image",
      "method": "POST",
      "headers": { "content-type": "application/json" },
      "body": { "model": "gpt-image-2", "image": "<https url to source image>", "prompt": "<edit instruction>", "size": "1024x1024" }
    },
    "resultSchema": { "type": "object", "required": ["data"], "properties": { "data": { "type": "array" } } }
  }
}
```

## 6. prepaid-key — agent self-onboarding ("tap")

```json
{
  "capabilityId": "mapleai-prepaid-key",
  "category": "onboarding",
  "provider": "MapleAI",
  "capabilityDescription": "One x402 payment mints an oms_buy_... bearer key for https://mapleai.shop/v1 (our prepaid OpenAI gateway). Empty body buys the cheapest 100k-token pack currently on sale. Good for repeated calls: pay once per pack instead of per request. The key also spends directly on the purchase gateway with no x402: POST {origin}/prepaid/v1/chat/completions (Bearer), and free key status: GET {origin}/prepaid/status (apex equivalent: GET https://mapleai.shop/v1/prepaid/status).",
  "endpoint": "https://base.mapleai.shop/prepaid/codes/auto",
  "providerPriceAtomic": "9500 (cheapest auto pack on Base: $0.007 + $0.0025 fee) up to 2802500 (1M-token gpt-5.6-sol pack incl. fee)",
  "contract": {
    "request": {
      "url": "https://base.mapleai.shop/prepaid/codes/auto",
      "method": "POST",
      "headers": { "content-type": "application/json" },
      "body": {}
    },
    "resultSchema": {
      "type": "object",
      "required": ["code", "model", "tokens", "api_base", "status_url"],
      "properties": {
        "code": { "type": "string", "pattern": "^oms_buy_" },
        "model": { "type": "string" },
        "tokens": { "type": "object" },
        "api_base": { "type": "string" },
        "status_url": { "type": "string" }
      }
    }
  }
}
```

## 7. embeddings — free

```json
{
  "capabilityId": "mapleai-embeddings",
  "category": "embeddings",
  "provider": "MapleAI",
  "capabilityDescription": "FREE embeddings, no payment and no key: 2048-dim vectors, NVIDIA nemotron-3-embed-1b, string or up to 128 strings per call, optional input_type query|passage. Response carries hint_next pointing to the paid gpt-chat capability.",
  "endpoint": "https://base.mapleai.shop/v1/embeddings",
  "providerPriceAtomic": "0",
  "contract": {
    "request": {
      "url": "https://base.mapleai.shop/v1/embeddings",
      "method": "POST",
      "headers": { "content-type": "application/json" },
      "body": { "input": "text or [up to 128 strings]" }
    },
    "resultSchema": { "type": "object", "required": ["data"], "properties": { "data": { "type": "array" } } }
  }
}
```

## 8. claude-messages — Anthropic Messages API

```json
{
  "capabilityId": "mapleai-claude-messages",
  "category": "text",
  "provider": "MapleAI",
  "capabilityDescription": "Native Anthropic Messages API (content blocks, system prompt, anthropic SSE events, max_tokens required). 10 live Claude models: haiku-4-5 $0.50/$2.50, sonnet-4.5/4.6 $1.50/$7.50, sonnet-5/5.5 $1/$5, opus-4.6/4.7/4.8/5 $2.50/$12.50, opus-5.5 $2/$10 per 1M in/out. Works with the Anthropic SDK pointed at this base URL.",
  "endpoint": "https://base.mapleai.shop/v1/messages",
  "providerPriceAtomic": "token-priced per model ($0.50-$2.50 per 1M in, $2.50-$12.50 per 1M out) + per-network fee",
  "contract": {
    "request": {
      "url": "https://base.mapleai.shop/v1/messages",
      "method": "POST",
      "headers": { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      "body": { "model": "claude-haiku-4-5", "max_tokens": 256, "messages": [{ "role": "user", "content": "<prompt>" }] }
    },
    "resultSchema": { "$ref": "Anthropic Message object" }
  }
}
```

---

## Outreach draft (send later — saved here, not sent)

To: Tenjin founders (link "Talk to the founders" at https://tenjin.blog, or GitHub)

Subject: MapleAI as a shelf provider — your CLI already drove 212 paid Jev calls in one evening

> Hi — your tenjin-cli made 212 settled x402 calls to our Jev endpoint on Base in
> ~3 hours yesterday (payer 0x3200E728…, 100% success, $0.43 total). Whoever was
> running it: thanks, the audit corpus on x402 idempotency was a great stress test.
>
> We'd like to be on the shelf officially. MapleAI is an x402-native
> OpenAI-compatible API on Base (also Solana, Polygon, Arc): cheap GPT chat from
> $0.001, Claude via the native Anthropic Messages API (10 models, from $0.50/1M
> input), images at $0.02, structured decisions (Jev), free 2048-dim embeddings,
> and a one-payment self-onboarding tap that mints prepaid keys.
>
> Full capability mapping in Tenjin router vocabulary is attached
> (capabilityId/category/endpoint/providerPriceAtomic/contract per route).
> Machine-readable: https://base.mapleai.shop/service-endpoints.json,
> https://base.mapleai.shop/openapi.json, https://base.mapleai.shop/.well-known/agent-card.json
>
> Already indexed and ownership-verified on x402scan under
> https://sol.mapleai.shop; CDP facilitator settles Base.
>
> Happy to answer anything — what fits your roadmap?

Notes for us when sending:
- Attach this file (or paste capabilities inline).
- Reference tx batch of 2026-09-29 as usage proof.
- Ask whether they prefer per-request x402 routes or the prepaid-tap flow for their CLI defaults.
