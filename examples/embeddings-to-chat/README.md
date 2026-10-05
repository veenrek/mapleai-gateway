# MapleAI embeddings to chat

This runnable example embeds a question and a small local FAQ with the free MapleAI embeddings endpoint, ranks the FAQ entries locally, then sends the best matches to paid GPT chat through x402.

## Requirements

- Node.js 22 or later
- A funded Base or Solana wallet for a paid run
- USDC on the selected network

The `--quote-only` mode calls free embeddings and reads the chat price challenge without signing or sending payment. The example sends a sample question and FAQ text to MapleAI; use non-sensitive text only.

## Run

```sh
npm install
cp env.example .env
```

For Base, set `EVM_PRIVATE_KEY` in `.env`. For Solana, set `MAPLEAI_NETWORK=solana` and `SVM_PRIVATE_KEY` to a base58 encoded 64-byte keypair. The example accepts only Base and Solana, and limits each payment to `MAPLEAI_MAX_PAYMENT_USDC`.

Check retrieval and quote without paying:

```sh
npm run demo -- --quote-only "How do I use embeddings with MapleAI?"
```

Run the full flow, including the paid GPT call:

```sh
npm run demo -- "How do I use embeddings with MapleAI?"
```

The API keys and wallet secret stay in the local `.env`; do not commit that file. The embeddings call is free. The chat call signs only the x402 challenge from the selected MapleAI network and enforces the configured spending cap.
