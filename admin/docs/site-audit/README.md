# Site Audit — Topic Index

Findings from exploring third-party API relay/provider sites (curl probes, JS bundle inspection,
own-account API calls). Results recorded so the omni router doesn't have to
re-probe. Per-topic details live in [`topics/`](topics/).

| Site                                   | Status | Profile                                                                                   | File                                         |
| -------------------------------------- | ------ | ----------------------------------------------------------------------------------------- | -------------------------------------------- |
| [NexoToken](https://www.nexotoken.net) | up     | new-api v0.12.7, mixed billing (per-token + per-request), "astra-sol" / "astra-pro" lines | [`topics/nexotoken.md`](topics/nexotoken.md) |

## Conventions used in probes

- **404 check**: root `/` returning 404 does not mean the site is down — the relay API
  endpoints may still respond (e.g. `/v1/models` 200). Check actual API paths.
- **Owned-by header trick**: `owned_by: "new-api"` in model-list JSON confirms new-api
  in one request without extra probing.
- **Generic new-api model probe**: use bare model IDs (`gpt-5.4`, not `openai/gpt-5.4`).
