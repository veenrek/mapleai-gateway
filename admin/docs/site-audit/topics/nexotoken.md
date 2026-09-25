# NexoToken — Site Exploration

> Explored: 2026-03-28 · Agent: site-explorer (OpenClaw)
> URL: https://www.nexotoken.net · Status: **up**
> Is new-api: **Yes** (confirmed 3 ways: `/api/status` returns `new_api_user`, `/v1/models` returns
> standard new-api relayed payload with `owned_by: "new-api"`, public field idiom `created: 1677610602`,
> new-api badges in own new-api logs)
> Deployed version: **v0.12.7** (as reported by site `/api/status`)

## Facts (verified by direct request unless noted)

| Item               | Value                                                             | Evidence                                     |
| ------------------ | ----------------------------------------------------------------- | -------------------------------------------- |
| Base URL           | `https://www.nexotoken.net/v1`                                    | Site pricing copy + JS bundle                |
| API key required   | Yes (`sk-...`; free accounts get one on register)                 | 401 without `Authorization`                  |
| Model catalog size | ~82 entries in `/v1/models`                                       | Probed `gpt-5.4` family successfully via key |
| Billing model      | Mixed: per-token (official channels) + per-request                | Pricing page has 按量 / 按次 tabs            |
| Astra lines        | **astra-sol** (per-token) and **astra-pro** (per-request)         | Named channel in own new-api logs            |
| Quota display      | Quota is relay-standard ($ based); conversion appears quota-based | `/api/used_quota` etc. respond               |

## Confirmed working models (probed 200 with generated content)

| Probe target              | Channel used              | Result |
| ------------------------- | ------------------------- | ------ |
| `gpt-5.4`                 | `gpt-official`            | 200 OK |
| `gpt-5.4` via `astra-sol` | `astra-sol`               | 200 OK |
| `gpt-5.4` via `astra-pro` | `gpt-official` (fallback) | 200 OK |

## Known quirks (from own new-api logs)

- `gpt-5.4` prefixed with `openai/` (i.e. `openai/gpt-5.4`) **fails with 400 "无可用渠道"** while bare `gpt-5.4` succeeds — the `openai/` prefix is not mapped.
- `astra-pro` per-request channel sometimes fails over to `gpt-official` mid-request (records show alternate billing path for same channel name).

## Hints for omni

- **For opaque structure (no public docs)**: treat `astra-sol` vs `astra-pro` as opaque relay classes; probe both when a model 404s/400s under one class.
- **For model naming**: NexoToken does **not** accept the `openai/<model>` prefix convention. Register bare model IDs only.
- Endpoint search IDs are undocumented; default to treating the relay as generic-compatible with standard `/v1/chat/completions`, `/v1/responses`, `/v1/embeddings`, `/v1/images`, `/v1/video` (probe-once pattern: single 200 confirms route exists without burning request budget).
