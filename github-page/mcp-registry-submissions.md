# MapleAI MCP — регистрационные тексты для реестров

Карточки готовы к копипасте. Версия пакета: `mapleai-mcp@0.3.1`.

## Подготовка перед подачей

```sh
cd packages/mapleai-mcp
npm ci && npm run build
npm pack   # свежий .tgz на проверку
npm publish --access public   # нужен логин npm (2FA)
```

После публикации мгновенная проверка из чистого каталога:

```sh
npx -y -p mapleai-mcp@0.3.1 mapleai-quickstart --network base
```

---

## 1. Официальный MCP Registry (registry.modelcontextprotocol.io)

Раздел Community Servers из README modelcontextprotocol/servers убран — подача теперь
идёт в MCP Registry через `mcp-publisher` CLI (GitHub device-flow auth).

Готово в репо: `packages/mapleai-mcp/server.json` (валидирован `mcp-publisher validate`),
`mcpName` в package.json (`io.github.veenrek/mapleai-mcp`).

Порядок:
1. npm версия с `mcpName` опубликована (0.3.1+).
2. `mcp-publisher login github` → открыть https://github.com/login/device, ввести код.
3. `mcp-publisher publish` из `packages/mapleai-mcp`.
4. Проверка: `curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=mapleai"`.

## 2. Glama.ai (glama.ai/mcp/servers)

Подача через «Add server» → GitHub URL репозитория (`https://github.com/veenrek/mapleai-gateway`, пакет — `packages/mapleai-mcp`). Текст описания:

> Local stdio MCP server for MapleAI's pay-per-request AI API. Eight tools: three
> free calls (model catalog, 2048-dim embeddings, prepaid key status), four
> x402-paid calls (chat completions, Jev structured decisions, autonomous agent
> execution, prepaid key purchase) and prepaid chat, which spends an issued key
> budget with no wallet.
> Implements full x402 payment locally: reads the 402 challenge, verifies network,
> asset, recipient and the MCP_MAX_PAYMENT_USDC / MCP_MAX_PREPAID_USDC spending
> caps, then signs with the configured wallet. Networks: Solana, Base, Polygon,
> Arc. Provider-listed on x402scan with ownership-verified resources.

Config для клиента (нужен в карточке Glama):

```json
{
  "mcpServers": {
    "mapleai": {
      "command": "npx",
      "args": ["-y", "-p", "mapleai-mcp", "mapleai-mcp"],
      "env": {
        "EVM_PRIVATE_KEY": "0xYOUR_KEY",
        "SVM_PRIVATE_KEY": "YOUR_BASE58_KEY",
        "MCP_PAY_TO_BASE": "0x63db6eaf635a31bbc6714fe37bdc85243864f611",
        "MCP_PAY_TO_SOLANA": "9DbpH2Mf9D26ak4bASsv6KA4Ra4V571oLpiVdZjAjcU8",
        "MCP_MAX_PAYMENT_USDC": "0.10",
        "MCP_MAX_PREPAID_USDC": "3.00"
      }
    }
  }
}
```

Tools quality report Glama прогонит сам (у нас 8 тулз с полными схемами + smoke-test в репо).

## 3. mcp.so

Форма «Submit MCP Server» с GitHub-ссылкой (`https://github.com/veenrek/mapleai-gateway`) и описанием. Short description (≤160 символов):

> Pay-per-request GPT, embeddings and agents with x402 USDC - 4 networks, 8 tools, zero accounts.

Long description — как у Glama (п.2).

## 4. PulseMCP (pulsemcp.com/servers)

Заявка «Submit a server»:
- Name: MapleAI MCP
- Homepage: https://sol.mapleai.shop
- GitHub: https://github.com/veenrek/mapleai-gateway (пакет в packages/mapleai-mcp)
- Licensing: Proprietary (источник доступен)
- Description (п.2, короче до 2-3 предложений).

## 5. Smithery.ai

Требует hosting-совместимость (streamable HTTP). Текущий пакет stdio — подача
возможна только в виде self-host карточки «build from source». Раздел «deployment»:

```yaml
startCommand:
  type: stdio
  command: npx
  args: [-y, -p, mapleai-mcp, mapleai-mcp]
  env:
    EVM_PRIVATE_KEY: "${USER_EVM_KEY}"
    MCP_PAY_TO_BASE: "0x63db6eaf635a31bbc6714fe37bdc85243864f611"
```

Через Smithery будет работать только с remote/self-host сценарием; hosted-эндпоинт
`sol.mapleai.shop/mcp` нужен для верхнего уровня каталога — отдельной задачей позже.

## 6. A2A-реестры (дополнительные каналы)

Agent card уже жив: `https://sol.mapleai.shop/.well-known/agent-card.json` (8 skills).
Если встретишь каталог A2A-агентов — подаётся именно этот URL плюс
`https://base.mapleai.shop/.well-known/agent-card.json` и т.д. (карта генерируется из живого конфига).
