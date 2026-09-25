# MapleAI — подключение к API из инструментов (Codex / OpenCode / VS Code / Hermes)

Эндпоинт (OpenAI-совместимый, поддерживает Chat Completions + Responses API):

```
Base URL : http://<адрес-сервера>:7777/v1
API Key  : oms_buy_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx   (ваш prepaid-ключ)
Model    : gpt-5.6-sol
```

Быстрая проверка баланса ключа: `http://<адрес-сервера>:7777/check`.

---

## 1. Codex CLI (OpenAI Codex / codex CLI)

`~/.codex/config.toml`:

```toml
model = "gpt-5.6-sol"
model_provider = "mapleai"
preferred_auth_method = "apikey"

[model_providers.mapleai]
name = "MapleAI"
base_url = "http://<адрес-сервера>:7777/v1"
wire_api = "responses"          # ВАЖНО: у нас первичный протокол — /v1/responses
env_key = "MAPLEAI_API_KEY"
```

Переменная окружения (в shell, в котором запускаете codex):

```bash
# macOS/Linux:
export MAPLEAI_API_KEY="oms_buy_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
# Windows PowerShell:
$env:MAPLEAI_API_KEY="oms_buy_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

Запуск: `codex` — модель gpt-5.6-sol пойдёт через наш прокси.

---

## 2. OpenCode

`~/.config/opencode/opencode.json` (или локальный `opencode.json` в проекте):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "mapleai": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "MapleAI",
      "options": {
        "baseURL": "http://<адрес-сервера>:7777/v1",
        "apiKey": "oms_buy_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
      },
      "models": {
        "gpt-5.6-sol": { "name": "GPT-5.6 Sol (MapleAI)" }
      }
    }
  },
  "model": "mapleai/gpt-5.6-sol"
}
```

---

## 3. VS Code

Официальный способ — расширение **Continue** (или любое с поддержкой custom OpenAI-compatible provider).

`%USERPROFILE%\.continue\config.yaml`:

```yaml
name: Local Assistant
models:
  - name: gpt-5.6-sol
    provider: openai
    model: gpt-5.6-sol
    apiBase: http://<адрес-сервера>:7777/v1
    apiKey: oms_buy_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
    roles: [chat, edit, autocomplete]
```

---

## 4. Hermes Agent (и любой агент с настройкой OpenAI-compatible endpoint)

Стандартный набор переменных, который берёт большинство агентов:

```bash
export OPENAI_BASE_URL="http://<адрес-сервера>:7777/v1"
export OPENAI_API_KEY="oms_buy_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
export OPENAI_MODEL="gpt-5.6-sol"
```

Если агент хочет только " Responses API" (строгий Codex-стиль) — base_url тот же (`/v1`), у нас оба протокола принимаются на одном порту.

---

## Проверка подключения из терминала

```bash
curl -X POST http://<адрес-сервера>:7777/v1/responses \
  -H "Authorization: Bearer oms_buy_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.6-sol",
    "stream": false,
    "input": [{"type":"message","role":"user","content":[{"type":"input_text","text":"say ok"}]}]
  }'
```

Ожидаемый ответ: `200` с `{"status":"completed", ...}`.

## Типовые ошибки

| Ошибка | Причина | Что делать |
|---|---|---|
| `401 Invalid marketplace buyer key` | ключ неправильный или отключён | проверить на странице `/check` |
| `402 Insufficient prepaid tokens` | бюджет исчерпан | запросить пополнение |
| `403 ... not allowed` | модель не в вашем списке разрешённых | использовать только `gpt-5.6-sol` |
| Таймаут >10 мин | апстрим медлит на огромном контексте | уменьшить контекст / повторить |
