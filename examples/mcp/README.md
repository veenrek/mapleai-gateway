# MapleAI MCP example

The local MCP server exposes eight tools. Free: `list_models`, `embed_text`, `prepaid_status`. Paid with x402 USDC: `chat_completion`, `jev_decide`, `agent_execute`, `buy_prepaid_tap`. And `prepaid_chat` spends a prepaid `oms_buy_` key instead of x402 — no wallet needed once a key is bought. It works with MCP clients that can launch a local stdio server. The client itself does not need x402 support: the local server handles the HTTP 402 challenge, signs it, and retries the request.

## Setup

1. Install Node.js 20+ and run `npx -y -p mapleai-mcp mapleai-quickstart --network polygon` to inspect a free quote.
2. Fund a wallet with USDC on the network you plan to use. Set `EVM_PRIVATE_KEY` for Base, Polygon, or Arc, or `SVM_PRIVATE_KEY` for Solana. The Solana key can be a base58 encoded keypair or a JSON array of keypair bytes.
3. Configure your MCP client with [client-config.example.json](client-config.example.json). Replace the key placeholder. Keep the key out of source control.
4. Set the expected payment recipient: `MCP_PAY_TO_POLYGON`, `MCP_PAY_TO_BASE`, `MCP_PAY_TO_ARC`, or `MCP_PAY_TO_SOLANA`. Confirm it against the corresponding `/.well-known/x402` manifest. The current Polygon, Base, and Arc recipient is `0x63db6eaf635a31bbc6714fe37bdc85243864f611`; the Solana recipient is `9DbpH2Mf9D26ak4bASsv6KA4Ra4V571oLpiVdZjAjcU8`.

Polygon is the default network; set `MCP_NETWORK` to change the default or use the `network` tool argument to select `base`, `polygon`, `arc`, or `solana` per call. Two spend caps apply: `MCP_MAX_PAYMENT_USDC` limits each metered call — chat, Jev, agent execution (default 0.10) — and `MCP_MAX_PREPAID_USDC` limits each prepaid key pack from `buy_prepaid_tap` (default 3.00, which covers the largest 1M-token pack at about $2.80). A request above the limit is rejected before signing, with an error naming the variable to raise.

Example tool call:

```json
{
  "name": "chat_completion",
  "arguments": {
    "network": "polygon",
    "model": "openai/gpt-6-luna",
    "messages": [{ "role": "user", "content": "Hello in one sentence." }],
    "max_tokens": 64
  }
}
```

The response includes the model output, charged USDC amount, network, and transaction hash when the facilitator provides it. Wallet secrets stay in the local MCP process. Review your MCP client's handling of local environment variables and tool approvals before connecting a funded wallet.
