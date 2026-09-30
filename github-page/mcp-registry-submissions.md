# MapleAI MCP — регистрационные тексты для реестров

Карточки готовы к копипасте. Версия пакета: `mapleai-mcp@0.2.0`.

## Подготовка перед подачей

```sh
cd packages/mapleai-mcp
npm ci && npm run build
npm pack   # свежий .tgz на проверку
npm publish --access public   # нужен логин npm (2FA)
```

После публикации мгновенная проверка из чистого каталога:

```sh
npx -y -p mapleai-mcp@0.2.0 mapleai-quickstart --network base
```

---

## 1. modelcontextprotocol/servers (официальный реестр)

Формат: pull request, добавление в README в раздел «Community Servers» (алфавитно по **M**):

```md
- **[MapleAI MCP](https://github.com/<org>/<repo>/tree/master/packages/mapleai-mcp)** — GPT chat, free embeddings, image generation, Jev structured decisions and prepaid API keys. Local x402 USDC payments behind standard MCP tools (`list_models`, `embed_text`, `chat_completion`, `jev_decide`, `buy_prepaid_tap`, `prepaid_status`) on Solana, Base, Polygon and Arc.
```

Перед PR проверить чек-лист репозитория (`CONTRIBUTING.md` официального реестра).

## 2. Glama.ai (glama.ai/mcp/servers)

Подача через «Add server» → GitHub URL репозитория. Текст описания:

> Local stdio MCP server for MapleAI's pay-per-request AI API. Six tools: two free
> discovery endpoints (model catalog, 2048-dim embeddings) and four x402-paid calls
> (chat completions, Jev structured decisions, prepaid key purchase and status).
> Implements full x402 payment locally: reads the 402 challenge, verifies network,
> asset, recipient and the MCP_MAX_PAYMENT_USDC spending cap, then signs with the
> configured wallet. Networks: Solana, Base, Polygon, Arc. Provider-listed on
> x402scan with ownership-verified resources.

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
        "MCP_MAX_PAYMENT_USDC": "0.10"
      }
    }
  }
}
```

Tools quality report Glama прогонит сам (у нас 6 тулз с полными схемами + smoke-test в репо).

## 3. mcp.so

Форма «Submit MCP Server» с GitHub-ссылкой и описанием. Short description (≤160 символов):

> Pay-per-request GPT, images and embeddings with x402 USDC - 4 networks, 6 tools, zero accounts.

Long description — как у Glama (п.2).

## 4. PulseMCP (pulsemcp.com/servers)

Заявка «Submit a server»:
- Name: MapleAI MCP
- Homepage: https://sol.mapleai.shop
- GitHub: (URL репозитория из ветки publish)
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
