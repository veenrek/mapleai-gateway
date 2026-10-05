# MapleAI MCP

Local stdio MCP server for MapleAI model calls paid with x402 USDC — GPT via the OpenAI-compatible API and Claude via the Anthropic Messages API. The MCP client does not need native x402 support. The local server reads the HTTP 402 challenge, checks the network, asset, recipient and spending limit, signs with a local wallet, and retries the request.

Requires Node.js 20 or newer.

## Quickstart

Check the model, network and exact quote without paying:

```sh
npx -y -p mapleai-mcp mapleai-quickstart --network polygon
```

To make a paid request, set `EVM_PRIVATE_KEY` and `MCP_PAY_TO_POLYGON=0x63db6eaf635a31bbc6714fe37bdc85243864f611` in your local environment, then run:

```sh
npx -y -p mapleai-mcp mapleai-quickstart --network polygon --pay
```

`MCP_MAX_PAYMENT_USDC` caps each metered call — chat, Jev and agent execution (default 0.10). Prepaid key purchases have their own cap, `MCP_MAX_PREPAID_USDC` (default 3.00), which covers the largest key pack. A paid run reports the model response and settlement transaction when provided by the facilitator. The quote can change between the display and the signed request; the signed request is checked again against the limit, and an over-limit quote is rejected before signing with an error naming the variable to raise.

For Base and Arc, use `EVM_PRIVATE_KEY` and the corresponding `MCP_PAY_TO_BASE` or `MCP_PAY_TO_ARC`. For Solana, use `SVM_PRIVATE_KEY` and `MCP_PAY_TO_SOLANA=9DbpH2Mf9D26ak4bASsv6KA4Ra4V571oLpiVdZjAjcU8`. Verify the recipient against the domain's `/.well-known/x402` manifest before funding a wallet.

## MCP client

```json
{
  "mcpServers": {
    "mapleai": {
      "command": "npx",
      "args": ["-y", "-p", "mapleai-mcp", "mapleai-mcp"],
      "env": {
        "EVM_PRIVATE_KEY": "0xYOUR_PRIVATE_KEY",
        "MCP_PAY_TO_POLYGON": "0x63db6eaf635a31bbc6714fe37bdc85243864f611",
        "MCP_MAX_PAYMENT_USDC": "0.10",
        "MCP_MAX_PREPAID_USDC": "3.00"
      }
    }
  }
}
```

Tools:

| Tool | Cost | Purpose |
| --- | --- | --- |
| `list_models` | free | Model catalog and prices |
| `embed_text` | free | 2048-dim embeddings (query/passage) |
| `prepaid_status` | free | Prepaid key validity and remaining tokens |
| `chat_completion` | x402 per call | GPT chat completions |
| `claude_message` | x402 per call | Claude models via the Anthropic Messages API (sonnet-5, opus-4-8, opus-5; max_tokens required) |
| `jev_decide` | x402 per call | Jev structured decisions |
| `agent_execute` | x402 per call | Autonomous agent execution (multi-step reasoning; calculator/fetch_url/web_search/data_analysis tools, plus code_exec where a sandbox executor is deployed; engines agents/oss-20b cheap and agents/gpt-6-sol premium; stream=true streams SSE step events) |
| `buy_prepaid_tap` | $0.008-$2.80 by pack | Issue a prepaid API key for https://mapleai.shop/v1 (default: smallest pack of the cheapest model on sale; optional model + tokens, price = tokens x input rate) |
| `prepaid_chat` | prepaid budget | Chat completions with a prepaid `oms_buy_` key as Bearer — no wallet, no x402; spend bounded by the key budget |

Supported networks: Polygon, Base, Arc and Solana. Polygon is the default network; override it per call with the `network` tool argument or set `MCP_NETWORK` to change the default. Keep wallet keys in a secure local client configuration and enable tool approval for paid calls.
