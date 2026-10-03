# Чек-лист: новый платный эндпоинт x402

Каждый новый эндпоинт должен пройти ВСЕ пункты. Шаблон рассчитан на
Express-гейтвеи (`/opt/claude-api-{sol,base,polygon,arc}`), x402-middleware,
дискавери Bazaar/x402scan и наши собственные мониторы.
Ссылки на места в коде указаны по состоянию на 2026-10.

## A. Регистрация в коде (обязательно)

- [ ] **Маршрут в PAID_ROUTES** (`src/index.ts`) — `paidRoute` с:
  description, `declareDiscoveryExtension({ input, inputSchema, bodyType, output })`,
  quote-функцией, upfront-флагом, тегами.
- [ ] **Validator + handler** через `app.post(PATH, validateX, (req,res)=>handleX(...))`.
  Валидация ошибок должна возвращать `details.availableModels/details.hint`
  (паттерн `prepaid-codes.ts`) — агенты читают recovery-подсказки.
- [ ] **paidPaths** (`src/payment-events.ts`) — path в `paidPaths` set, иначе
  settles не попадут в учёт (реальный баг 2026-10-01).
- [ ] **Feature flag**: включение через env (`X402_*_KEY`/`Boolean(config…)`)
  и проверка присутствия ключа на ВСЕХ 4 гейтвеях — иначе 404 на части зеркал
  (баг лета 2026). Проверка: `for d in sol base polygon arc; grep varnname /opt/claude-api-$d/.env`.
- [ ] **Discovery пример правдив**: `output.example` — проигранный вживую ответ,
  а не выдуманный. Bazaar/monitors верифицируют shape.
- [ ] **openapi.json секция** (генератор в `src/index.ts`, блок `/.../path`: post):

  - summary/description с ценой и пределами;
  - `x-worked-example` — реальный вызов с настоящими полями;
  - `x-pricing` — модель цены (ceiling/flat/per-unit);
  - requestBody example; responses с real shape.
- [ ] **Плоские каталоги** в `src/index.ts`:
  `/docs` endpoints listing (описание + price + pricedBy),
  текстовая секция `— Usage #`-блок, README-раздел если публичный.
- [ ] **`/.well-known/x402`** манифест содержит новый путь (проверить curl'ом).
- [ ] **AI-AGENTS.md**: секция в `templates/AI-AGENTS.md` (все 4 сабдомена) и
  `public/AI-AGENTS.md` (apex) — формат: что делает, цена, ВЫЗОВ-пример,
  статусы/ошибки, восстановление.

## B. Спецификация описания (для Bazaar/x402scan и подобных)

Bazaar pay-ai и x402-observer строят карточку из этих данных — они должны быть
честными и самодостаточными даже без документации:

- [ ] **description ≤ 2 предложения**: что делает + ценовая модель + пределы.
  Пример эталона: «Autonomous agent execution (multi-step reasoning + tools).
  Engines: cheap agents/oss-20b or premium agents/gpt-6-sol; stream=true streams
  SSE step events. Ceiling = engine base + max_steps × step (charged_ceiling_usd).»
- [ ] **Входной inputSchema complete**: required, types, enum, ranges, defaults,
  описания полей для машинного readability.
- [ ] **Цена честная**: если биллинг по ceiling — прямо сказано «charged at the
  max_steps ceiling, shown as charged_ceiling_usd»; если реальное — «charged by
  usage». Никаких «≈$0.001» без объяснения.
- [ ] **Ответная схема стабильна**: поля не переименовываем без версии; новые
  поля — как extensions (совместимо по superset).
- [ ] **Статuses/ошибки — машиночитаемы**: enum статусов (completed/failed/timeout),
  поля `reason`, HTTP-коды (400 validation / 402 paywall / 503 upstream down).
- [ ] **Теги**: 3–5 из списка ["AI","inference","LLM","chat","embeddings","image",
  "audio","agents","prepaid","credits","decision"] — нужно для фасетных фильтров.
- [ ] **SSE вместо долгого JSON**: endpoint дольше CF 100 s до первого байта —
  обязательно `stream`-режим (open/step/done паттерн), иначе край Cloudflare убьёт.
- [ ] **Латентность шага/запроса**: 95-й перцентиль должен укладываться в Apache
  Timeout 300 и CF 100 (для non-stream).
- [ ] **Никаких секретов в примерах**: ключи/токены только плейсхолдерами
  (`oms_buy_…`, `0x…`).

## C. Проверка перед выкатом

- [ ] **402 на всех 4 зеркалах** (не 404/503): curl на каждом хосте.
- [ ] **Платный проход 200** (одна реальная покупка $0.002–0.01 с кошелька
  сентинела; проверить `settled`-запись с tx hash в payment-events).
- [ ] **Тесты**: unit на валидацию/расчёт/парсер; `npm test`-семья зелёна;
  tsc scoped по изменённым файлам.
- [ ] **Сентинел**: добавить `${flag} <name> challenge` пробу в
  `tools/agent-sentinel.mjs`; кап атомов с запасом на polygon-overhead
  (x2 от базовой цены минимум).
- [ ] **Откат готов**: бэкапы файлов (`.bak-YYYYMMDD`), билд-бэкап
  `.build-backups/` если админка.
- [ ] **Zombie-check после сборки**: `pkill -f jest-worker` если билдили
  (история 2026-10-01: 300 CPU-часов зомби).

## D. После выката

- [ ] **Наблюдать часовой отчёт сентинела**: новая проверка в списке проверок,
  кастомная строка метрик (например `via exa/ddg`).
- [ ] **Первые settles реально видны**: в Ru-отчёте «платежей за 24 ч» растёт;
  при 0 за 5+ дней — вернуться к воронке discovery.
- [ ] **Bazaar собирает карточку**: проверить через сутки, что описание в
  манифесте совпадает с ожиданием (доступно через checkChallenge разведчик).
- [ ] **Записать DEPLOY-дату**: таблица появления эндпоинта в деплойном журнале
  (чтобы trust-мониторы не репортили «новый путь без рейтинга»).

## Анти-паттерны (из наших инцидентов)

- Забытый путь в `paidPaths` → деньги есть, а в учёте нет.
- Env-ключ только на 2 из 4 зеркал → 404 на публичном роуте → trust-халт.
- Ответная схема без реального примера → Bazaar показывает пустые карточки.
- Митигация через одни воркеры Next.js при OOM → divide .build на части.
