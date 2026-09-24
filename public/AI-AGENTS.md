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

## Key Features
- **Claude-only focus**: 10 models from Anthropic
- **BlockRun-competitive pricing**: Starting at $5/1M tokens
- **OpenAI-compatible**: Drop-in replacement for OpenAI SDK
- **x402 payments**: Pay per request in USDC on Solana
- **No accounts**: Wallet address is your identity

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
