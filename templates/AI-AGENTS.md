# {{BRAND}} — AI Agent Discovery

## Service Overview
- **Name**: {{BRAND}}
- **Type**: LLM API provider (GPT models)
- **Protocol**: x402 (pay-per-request on {{CHAIN}})
- **Base URL**: {{API_BASE}}
- **Compatibility**: OpenAI Chat Completions + OpenAI Responses API
- **Contact**: {{CONTACT_EMAIL}}

## Available Models
{{MODEL_COUNT}} GPT models, priced per token. Full catalog: GET {{API_BASE}}/models

{{MODELS_LIST}}

{{AGENT_IMAGES}}
{{AGENT_AUDIO}}
{{AGENT_JEV}}
{{AGENT_AGENTS}}
{{AGENT_EMBEDDINGS}}
{{AGENT_FREE_OSS}}
{{AGENT_NFT}}
{{AGENT_PREPAID}}

## Quick Start for AI Agents

The code below shows the request format. A standard OpenAI SDK does not handle x402 payment automatically. Use an x402-aware client to read the 402 challenge, sign it and retry with PAYMENT-SIGNATURE.

### Python
```python
from openai import OpenAI

client = OpenAI(
    base_url="{{API_BASE}}",
    api_key="payment-signature-required"  # use an x402-aware client
)

response = client.chat.completions.create(
    model="{{DEFAULT_MODEL}}",
    messages=[{"role": "user", "content": "Hello"}]
)
```

### TypeScript
```typescript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: '{{API_BASE}}',
  apiKey: 'payment-signature-required' // use an x402-aware client
});

const response = await client.chat.completions.create({
  model: '{{DEFAULT_MODEL}}',
  messages: [{role: 'user', content: 'Hello'}]
});
```

### Responses API
```bash
curl {{ORIGIN}}/api/v1/responses \
  -H 'content-type: application/json' \
  -d '{"model":"{{DEFAULT_MODEL}}","input":"Hello"}'
```

## Discovery Endpoints

Developer guide with network URLs, model prices and request examples: {{ORIGIN}}/developers

### Service Index
`GET {{ORIGIN}}/service-endpoints.json`
One-shot machine-readable index: every route with its access mode
(x402 / free / prepaid bearer), live per-unit pricing and request examples.

### x402 Resource Manifest
`GET {{ORIGIN}}/.well-known/x402`
Machine-readable x402 resource manifest for wallet/agent discovery.

### A2A Agent Card
`GET {{ORIGIN}}/.well-known/agent-card.json`
A2A-protocol agent card: skills, x402 security scheme and the OpenAI-compatible
HTTP interface; use it for agent-to-agent service discovery.

### OpenAPI Specification
`GET {{ORIGIN}}/openapi.json`
Full API specification in OpenAPI 3.1 format, including per-model pricing.

### Model Catalog
`GET {{API_BASE}}/models`
Free list of available models with pricing and context windows.

## Paid Endpoints

| Method | Path | Protocol |
| --- | --- | --- |
| POST | `/v1/chat/completions` | OpenAI Chat Completions |
| POST | `/api/v1/chat/completions` | OpenAI Chat Completions (alias) |
| POST | `/api/v1/responses` | OpenAI Responses API (alpha) |
| POST | `/v1/responses` | OpenAI Responses API (alpha) |

{{AGENT_AUDIO_ENDPOINTS}}
{{AGENT_IMAGE_ENDPOINTS}}
{{AGENT_JEV_ENDPOINT}}
{{AGENT_AGENTS_ENDPOINT}}
{{AGENT_FREE_OSS_ENDPOINT}}
{{AGENT_PREPAID_ENDPOINT}}

## Payment Protocol
1. Send the request without payment
2. Receive HTTP 402 with the exact {{ASSET}} amount in the `PAYMENT-REQUIRED` header
3. Sign the {{ASSET}} transfer with your wallet
4. Retry with the `PAYMENT-SIGNATURE` header — the call executes immediately

Price = counted input tokens × input rate + requested output tokens × output rate,
floored at ${{MIN_CHARGE}} per paid request. Failed calls (HTTP >= 400 from the
model provider) are cancelled, not settled.

### Payment rules (critical for agents)
- **One signature = one request.** Every request needs its own 402 challenge and its own signed authorization.
- **Never reuse or fan out a `PAYMENT-SIGNATURE`.** Replays and parallel fan-out of one signed payload are rejected after the first settlement (`settlement_unconfirmed`).
- **On 402, start over**: fetch a fresh challenge and sign again — never pay against a stale quote.

## Agents API (`agent.execution`)

`POST /v1/agents/execute` runs a multi-step agent on a natural-language task. Payment: x402, or a prepaid `oms_buy_` Bearer key on the same URL.

### Request
| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `task` | string (required) | — | What the agent must do |
| `model` | `"agents/oss-20b"` \| `"agents/gpt-6-sol"` | `agents/oss-20b` | Cheap or premium engine |
| `context` | string | — | Untrusted data/constraints for the task |
| `max_steps` | int 1–20 | 8 | Reasoning/tool steps cap; also the billing ceiling |
| `tools` | array of `"calculator"` `"fetch_url"` `"web_search"` `"data_analysis"` `"code_exec"` | all | Tools the agent may call |
| `stream` | boolean | false | `true` → SSE stream of `open` / `step` / `done` events |

### Tools
- `calculator` — arithmetic only: `{"expression": "2*(3+4)/5"}` (digits, `+ - * / % ^ ( )`)
- `fetch_url` — downloads public page text: `{"url": "https://example.com"}` (max 3 per task)
- `web_search` — web search via keyless Exa (DuckDuckGo fallback): `{"query": "..."}` → title/url/snippet (max 3 per task)
- `data_analysis` — descriptive stats, no code execution: `{"data": [1,2,3], "field": "price"}` → count/sum/mean/median/min/max/stdev
- `code_exec` — sandboxed code execution: `{"language": "python", "code": "print(2+2)"}` with python / javascript / typescript → stdout/stderr + exit code; no network, no filesystem, no persistence (max 3 per task, $0.002 per call)
- Unknown tools are rejected with `tool_not_allowed`.

### Response (`application/json`, or the SSE `done` payload)
```jsonc
{
  "id": "agexec_<uuid>",
  "object": "agent.execution",
  "model": "agents/oss-20b",
  "task": "<task text>",
  "status": "completed | failed | timeout",
  "reason": "<only on failed/timeout>",
  "steps_executed": 2,
  "steps": [
    { "n": 1, "thought": "…", "action": "tool",
      "tool_call": { "name": "web_search", "args": { "query": "…" } },
      "tool_result": "…", "usage": { "input_tokens": 0, "output_tokens": 0 } },
    { "n": 2, "thought": "…", "action": "final",
      "usage": { "input_tokens": 0, "output_tokens": 0 } }
  ],
  "output": { "reasoning": "thought1 | thought2 | …", "result": "…",
              "confidence": null, "sources": [{ "url": "…", "title": "…" }] },
  "usage": {
    "input_tokens": 0, "output_tokens": 0,
    "reasoning_tokens": 0,  "action_tokens": 0,
    "total_tokens": 0, "tools_invoked": 0, "steps_executed": 2,
    "charge": { "base_usd": 0.002, "step_usd": 0.0005,
                "steps_charged_ceiling": 8, "charged_ceiling_usd": 0.006 }
  }
}
```

`status`: `completed` — answered; `timeout` — hit a per-step (30 s) or wall-clock ceiling and returns the executed steps so far; `failed` — protocol/upstream error (partial steps included, reason set).

### SSE (`"stream": true`)
`event: open` — charged ceiling, engine, step cap, enabled tools. `event: step` — each completed step as it happens. `event: done` — the full `agent.execution` JSON shown above.

### Billing
Charged at the ceiling: `base_usd + max_steps × step_usd` plus, when `code_exec` is allowed, `min(3, max_steps) × $0.002` (+ small settlement overhead), visible in `open` and in `usage.charge.charged_ceiling_usd` — no post-hoc extra fees. Per-tool counters land in `usage.charged_tools`.

| Engine | base/step | Use for |
| --- | --- | --- |
| `agents/oss-20b` | $0.002 / $0.0005 | quick lookups, arithmetic, short searches |
| `agents/gpt-6-sol` | $0.004 / $0.004 | hard multi-step reasoning, long fetch+analyze pipelines |

## Key Features
- **{{MODEL_COUNT}} GPT models**: GPT-5.6 Sol, GPT-5.6 Terra, GPT-6 Luna and GPT-6 Sol

## Audio

- **TTS** `POST /v1/audio/speech` — models `tts-1`, `tts-1-hd`, `orpheus-english`, `orpheus-arabic`; OpenAI voice presets (`alloy`, `nova`, `shimmer`, …). $0.015 flat per request via x402. Example: `{"model":"tts-1","input":"Hello","voice":"alloy","response_format":"wav"}` → WAV audio bytes.
- **STT** `POST /v1/audio/transcriptions` — models `whisper-1`, `whisper-large-v3`, `whisper-large-v3-turbo` (multipart `file` field). $0.006 flat per request via x402. Responses follow the OpenAI transcription schema (`text`, optionally `verbose_json` with segments).
- **Pricing**: 30% below published OpenAI rates, from ${{MIN_PRICE}} per 1M input tokens
- **OpenAI-compatible request format**: requires an x402-aware payment client
- **x402 payments**: pay per request in {{ASSET}} on {{CHAIN}}
- **No accounts**: your wallet address is your identity

## Technical Details
- **Network**: {{NETWORK}} ({{NETWORK_NAME}})
- **Payment token**: {{ASSET}} ({{ASSET_ADDRESS}})
- **Treasury (payTo)**: {{PAY_TO}}
- **Facilitator**: {{FACILITATOR}}
- **Minimum charge**: ${{MIN_CHARGE}} per paid request
- **Max context**: {{MAX_CONTEXT}} tokens

## Use Cases
- Autonomous AI agents with budget control
- Multi-agent systems (pay per agent, per request)
- Research and prototyping with no commitment
- Enterprise deployments that cannot hold API keys

## Support
- API status: {{ORIGIN}}/health
- Contact: {{CONTACT_EMAIL}}
- x402scan: https://x402scan.com
- Protocol docs: https://x402.org

---

**For AI agents**: every endpoint returns structured JSON. Point the OpenAI SDK at
`{{API_BASE}}` with any non-empty `api_key` and handle the 402 challenge with an
x402 client. Last updated: {{UPDATED}}.
