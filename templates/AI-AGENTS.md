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
{{AGENT_JEV}}
{{AGENT_EMBEDDINGS}}
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

{{AGENT_IMAGE_ENDPOINTS}}
{{AGENT_JEV_ENDPOINT}}
{{AGENT_PREPAID_ENDPOINT}}

## Payment Protocol
1. Send the request without payment
2. Receive HTTP 402 with the exact {{ASSET}} amount in the `PAYMENT-REQUIRED` header
3. Sign the {{ASSET}} transfer with your wallet
4. Retry with the `PAYMENT-SIGNATURE` header — the call executes immediately

Price = counted input tokens × input rate + requested output tokens × output rate,
floored at ${{MIN_CHARGE}} per paid request. Failed calls (HTTP >= 400 from the
model provider) are cancelled, not settled.

## Key Features
- **{{MODEL_COUNT}} GPT models**: GPT-5.6 Sol, GPT-5.6 Terra, GPT-6 Luna and GPT-6 Sol
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
