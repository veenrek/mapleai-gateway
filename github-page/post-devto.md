---
title: Pay for GPT with USDC, no account — free embeddings + x402 micropayments
published: false
tags: x402, usdc, ai, web3
---

# Pay for GPT with USDC, no account

Most LLM APIs want the same ritual before your first request: sign up, verify
email, add a card, generate an API key, worry about leaking it. We built
MapleAI to skip all of that — the OpenAI-compatible endpoint returns
`402 Payment Required`, your wallet signs a USDC transfer, and the call runs.
Your wallet address is your identity. No account, no key rotation, no monthly
bill.

And the retrieval half of a typical RAG flow is completely free.

## The flow: free embeddings, paid GPT

A question-answering agent usually does two things: find relevant context,
then generate an answer. On MapleAI the first step costs nothing:

```bash
# Free — no auth, no key
curl https://sol.mapleai.shop/v1/embeddings \
  -H 'content-type: application/json' \
  -d '{"input": "How do I pay for GPT with USDC?", "input_type": "query"}'
```

2048-dimensional vectors from NVIDIA Nemotron Embed 1B, up to 128 texts per
request, OpenAI SDK compatible. Details: [Free Embeddings API](https://sol.mapleai.shop/free-embeddings).

The second step is a normal chat completion — except the first response is a
payment challenge:

```bash
curl -i https://base.mapleai.shop/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"openai/gpt-6-luna","messages":[{"role":"user","content":"Hello"}],"max_tokens":64}'

# HTTP/1.1 402 Payment Required
# payment-required: eyJ4NDAyVmVyc2lvbiI6Miw...
```

An x402 client decodes the challenge, signs the exact USDC amount and retries.
This request costs about **$0.001** — a cent buys you ten calls.

## A real, runnable example

We published a small TypeScript app that does the whole loop:

1. embeds your question and a local FAQ with the free endpoint;
2. ranks FAQ entries by cosine similarity locally;
3. sends the best matches to `gpt-6-luna` through x402 and prints the answer.

```bash
git clone <your-repo-url>
cd examples/embeddings-to-chat
npm install && cp env.example .env   # add a funded Base or Solana wallet key

# Free dry run: retrieval + price quote, nothing is signed
npm run demo -- --quote-only "How do I use embeddings with MapleAI?"

# Full run: one micropayment, one answer
npm run demo -- "How do I use embeddings with MapleAI?"
```

The same example runs in the browser of our docs:
[embeddings-to-chat live example](https://base.mapleai.shop/examples/embeddings-to-chat/).

## What it costs

| Model | Input / 1M | Output / 1M |
| --- | ---: | ---: |
| GPT-6 Luna | $0.07 | $0.35 |
| GPT-5.6 Terra | $1.40 | $8.40 |
| GPT-6 Sol | $1.40 | $7.00 |
| GPT-5.6 Sol | $2.80 | $14.00 |

Plus image generation from $0.02, a structured-decision model (Jev) at
$0.06/1M input tokens, and prepaid token packs from $0.007 if you prefer a
budget over per-request payments. Failed calls (HTTP ≥ 400) are cancelled,
not settled.

Payments settle in USDC on Solana, Base, Polygon or Arc through the x402
protocol — pick the network by picking the subdomain:

```
https://sol.mapleai.shop      https://base.mapleai.shop
https://polygon.mapleai.shop  https://arc.mapleai.shop
```

## Why this matters for agents

An autonomous agent can't pass KYC and can't store a credit card. It *can*
hold a wallet. With x402 the entire commercial relationship is one HTTP
header: the agent reads the price, decides, pays, and gets the result in the
same session. Discovery is machine-readable end to end — `/openapi.json`,
`/.well-known/x402`, `/llms.txt` — so an agent can integrate without a human
writing glue code.

## Links

- Landing: **<GITHUB-PAGES-URL>** <!-- заменить после публикации -->
- Free embeddings: https://sol.mapleai.shop/free-embeddings
- Live example: https://base.mapleai.shop/examples/embeddings-to-chat/
- Model catalog: https://sol.mapleai.shop/v1/models
- Developers: https://sol.mapleai.shop/developers

*Built with the x402 protocol. Settlement by Coinbase CDP on Solana, Base and
Polygon; Arc uses a local facilitator.*
