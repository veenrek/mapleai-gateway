# Готовые тексты для подачи MapleAI в каталоги API

## 1. public-apis/public-apis (github.com/public-apis/public-apis)

Формат записи из их CONTRIBUTING (таблица в README, по алфавиту категории):

Подходящая категория: **Machine Learning**

```markdown
| [MapleAI Embeddings](https://sol.mapleai.shop/free-embeddings) | Free 2048-dim text embeddings (NVIDIA Nemotron Embed 1B), OpenAI-compatible | No | Yes | No |
```

Колонки: API | Description | Auth | HTTPS | CORS.
Auth = No (ключ не требуется), HTTPS = Yes, CORS = No — перепроверено
05.10.2026: заголовков `access-control-*` нет, это серверный API
(из браузера cross-origin не вызвать, через curl/SDK/сервер — можно).

PR title: `Add MapleAI Embeddings to Machine Learning`

---

## 2. awesome-free-apis / awesome-api lists

Короткая запись:

```markdown
- [MapleAI Free Embeddings](https://sol.mapleai.shop/free-embeddings) — Free OpenAI-compatible embeddings endpoint. NVIDIA Nemotron Embed 1B, 2048 dimensions, up to 128 inputs per request, no API key or account required.
```

---

## 3. Описание для каталогов с полем "long description"

```
MapleAI offers a free, OpenAI-compatible text embeddings API. The endpoint
runs NVIDIA Nemotron Embed 1B and returns 2048-dimensional float vectors for
a single string or a batch of up to 128 strings per request. It supports
query/passage input types for asymmetric retrieval and float/base64 encoding.

No API key, account or payment is required. Invalid requests return HTTP 400
with a machine-readable JSON schema of the valid request, so agents can
self-correct. The same project sells pay-per-request GPT and image generation
settled in USDC via the x402 protocol.

Endpoint: POST https://sol.mapleai.shop/v1/embeddings
Docs: https://sol.mapleai.shop/free-embeddings
OpenAPI: https://sol.mapleai.shop/openapi.json
```

---

## 4. Куда ещё подать (вручную)

- github.com/public-apis/public-apis — PR по шаблону выше
- github.com/public-api-lists/public-api-lists — аналогичная таблица
- awesome-листы по поиску "awesome free api" / "awesome llm"
- rapidapi.com — каталог с платным листингом, есть бесплатный tier
- x402scan.com — уже присутствуем (chat endpoints); проверить карточки
- agentic.market — уже валидировано для sol/base chat

## 5. Перед подачей проверить

Всё перепроверено 05.10.2026:

- [x] https://sol.mapleai.shop/free-embeddings отвечает 200 (на всех 4 доменах)
- [x] CORS: заголовков нет — в таблице ставим No (проверено)
- [x] Пример из записи реально работает (curl выше)
