# MapleAI — готовые карточки для каталогов (x402scan, API-листы, Bazaar)

Каждая карточка готова к копипасте: название, описание, теги, цена, пример запроса.
Эндпоинты зеркалированы на четырёх сетях (в карточках используется Solana; подставь
любой из `sol | base | polygon | arc .mapleai.shop` под желаемую сеть оплаты).

Документы дискавери (вкладывать в поле Documentation / Discovery):

- Service index: https://sol.mapleai.shop/service-endpoints.json
- OpenAPI: https://sol.mapleai.shop/openapi.json
- x402 manifest: https://sol.mapleai.shop/.well-known/x402
- Agent guide: https://sol.mapleai.shop/AI-AGENTS.md

---

## 1. Chat Completions (GPT-5.6 / GPT-6)

- **Endpoint**: POST https://sol.mapleai.shop/v1/chat/completions
- **Tags**: chat, llm, gpt, openai-compatible, x402, usdc
- **Price**: from $0.001 per request (dynamic: input tokens + max_tokens output)
- **Description**: OpenAI-compatible chat completions. 4 GPT models
  (GPT-6 Luna from $0.07/1M input). Pay per request in USDC over x402 — no
  accounts, no API keys. Exact quote and token breakdown in every 402 challenge.
- **Try it**:
  ```bash
  curl -X POST https://sol.mapleai.shop/v1/chat/completions \
    -H 'content-type: application/json' \
    -d '{"model":"openai/gpt-6-luna","messages":[{"role":"user","content":"Hello"}],"max_tokens":8}'
  ```
  без оплаты вернёт 402 с точной ценой; x402-клиент подпишет и повторит → 200.
- Алиасы: `/api/v1/chat/completions`, а также OpenAI **Responses API**: `/api/v1/responses`, `/v1/responses`.

## 2. Image Generation

- **Endpoint**: POST https://sol.mapleai.shop/api/v1/images/generations
- **Tags**: image, generation, dalle, gpt-image, x402
- **Price**: from $0.02 per image (7 models, по модели и размеру 1024x1024→4K)
- **Description**: Generate images with gpt-image and grok-imagine models, n 1–4.
  x402 pay-per-image in USDC; answer contains data[].url or data[].b64_json.
- **Try it**:
  ```bash
  curl -X POST https://sol.mapleai.shop/api/v1/images/generations \
    -H 'content-type: application/json' \
    -d '{"model":"gpt-image-2","size":"1024x1024","n":1,"prompt":"A maple leaf"}'
  ```

## 3. Image Editing (image-to-image)

- **Endpoint**: POST https://sol.mapleai.shop/api/v1/images/image2image
- **Tags**: image, editing, image2image, x402
- **Price**: from $0.02 per image
- **Description**: Edit a PNG, JPEG or WebP supplied as a base64 data URI
  (max 10 MB) with gpt-image models. Paid per edited image via x402.
- **Try it**:
  ```bash
  curl -X POST https://sol.mapleai.shop/api/v1/images/image2image \
    -H 'content-type: application/json' \
    -d '{"model":"gpt-image-2","size":"1024x1024","prompt":"Make the leaf green","image":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC"}'
  ```

## 4. Jev Structured Decisions

- **Endpoint**: POST https://sol.mapleai.shop/jev
- **Tags**: decision, classification, structured, agents, x402
- **Price**: $0.06/1M input tokens (about $0.0005 per short request)
- **Description**: jev-latest evaluates labelled questions against a state:
  named questions with type (noul/choice/score) and instructions in, JSON
  answers out. Built for agent routing, triage and scoring workflows.
- **Try it**:
  ```bash
  curl -X POST https://sol.mapleai.shop/jev \
    -H 'content-type: application/json' \
    -d '{"model":"jev-latest","state":"The customer was charged twice for one order.","questions":{"billing":{"type":"noul","instructions":"Is this about a billing issue?"}}}'
  ```

## 5. Free Embeddings

- **Endpoint**: POST https://sol.mapleai.shop/v1/embeddings
- **Tags**: embeddings, free, vector, semantic-search, rag
- **Price**: $0.00 (free, rate-limited, no payment)
- **Description**: Free NVIDIA nemotron-3-embed-1b embeddings, 2048-dim
  L2-normalized vectors, up to 128 strings per call. No key, no payment.
- **Try it**:
  ```bash
  curl -X POST https://sol.mapleai.shop/v1/embeddings \
    -H 'content-type: application/json' \
    -d '{"input":"What does MapleAI cost?","input_type":"query"}'
  ```

## 6. Prepaid API Keys

- **Endpoint**: POST https://sol.mapleai.shop/prepaid/codes (или `/prepaid/codes/auto` — пустое тело = пак 0.1M Luna)
- **Tags**: prepaid, credits, api-key, budget, x402
- **Price**: $0.007–$2.80 per pack (0.1M–1M tokens, по модели) + $0.001 fee
- **Description**: Buy a prepaid OpenAI-compatible API key for one GPT model
  with a token budget (100k–1M in 100k steps, priced at the input rate).
  Spend the key (Bearer, no x402) at POST {sol,base,polygon,arc}.mapleai.shop/prepaid/v1/chat/completions
  или на apex https://mapleai.shop/v1; usage/status check is free at
  GET {subdomain}/prepaid/status или https://mapleai.shop/v1/prepaid/status.
- **Try it (agent tap)**:
  ```bash
  curl -X POST https://sol.mapleai.shop/prepaid/codes/auto -H 'content-type: application/json' -d '{}'
  ```

## 7. General listing (одна карточка на сервис)

- **Name**: MapleAI — GPT, Agents, Images, Audio, X Intelligence API with x402 Pay-Per-Request
- **URL**: https://sol.mapleai.shop (mirrors: base/polygon/arc.mapleai.shop)
- **Tags**: x402, usdc, solana, base, polygon, arc, llm, agents, mcp, audio-api, image-api, embeddings, search, openai-compatible, prepaid
- **Price**: free tier, $0.001–$17.50 per request/pack
- **Description**: Pay-per-request AI API: GPT-6 combos, autonomous agent execution with tools and web search, image generation/editing from $0.02,
  audio TTS ($0.015) and STT ($0.006), embeddings with a free tier, Jev structured decisions, X intelligence (search/digest/sentiment/factcheck), and prepaid token packs.
  Pay in USDC over x402 on Solana, Base, Polygon or Arc. No accounts — your wallet is your identity. Machine-readable
  discovery: service-endpoints.json, OpenAPI, llms.txt, AI-AGENTS.md. MCP server for agents: npx mapleai-mcp.

---

## Поля для seller-панели x402scan (Claim/Edit listing)

- **Resource URL**: как в карточке выше (по одному URL на маршрут).
- **Description**: брать из поля Description карточки.
- **Tags**: как в карточке.
- **Price**: строки Price из карточки совпадают с полями `price` в
  `/.well-known/x402` — x402scan подтягивает их автоматически при crawl.
- **Docs/Homepage**: https://sol.mapleai.shop/developers
- **Status page**: https://sol.mapleai.shop/health
