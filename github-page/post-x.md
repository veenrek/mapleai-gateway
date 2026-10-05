# X (Twitter) тред — Pay for GPT with USDC, no account

## Твит 1 (hook)

We made an LLM API with no sign-up, no API keys and no card.

You call it → it answers 402 Payment Required → your wallet signs $0.001 in
USDC → the call runs.

OpenAI-compatible. GPT + images + free embeddings. 🧵

## Твит 2 (free hook)

The embeddings endpoint is just free.

POST /v1/embeddings — 2048-dim vectors (NVIDIA Nemotron 1B), batches of 128,
no auth at all. Perfect for the retrieval half of RAG.

https://sol.mapleai.shop/free-embeddings

## Твит 3 (how payment works)

Payment is one HTTP header. The 402 challenge carries the exact USDC amount,
an x402 client signs it, retries, done. Solana, Base, Polygon or Arc — pick a
subdomain, that's your network.

Failed calls are cancelled, not settled.

## Твит 4 (prices)

GPT-6 Luna: $0.07 / 1M input tokens.
A short chat request is about $0.001 — a cent buys ten calls.
Images from $0.02. Prepaid token packs from $0.007 if you want a budget.

## Твит 5 (example + CTA)

Runnable demo: free embeddings find your context, paid GPT answers, one
micropayment total.

https://base.mapleai.shop/examples/embeddings-to-chat/

Landing + docs: <GITHUB-PAGES-URL>

Agents can't pass KYC. They can hold a wallet. That's the point.

---

# Вариант одного твита (если без треда)

LLM API with no account and no API key: call → 402 → sign $0.001 USDC →
answer. OpenAI-compatible GPT, images from $0.02, and a completely free
embeddings endpoint (2048-dim, no auth). Built on x402.

https://sol.mapleai.shop/free-embeddings
<GITHUB-PAGES-URL>
