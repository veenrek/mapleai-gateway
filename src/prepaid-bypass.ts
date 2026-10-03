import type { NextFunction, Request, Response } from "express";
import { config } from "./config.js";

/** Marketplace prepaid buyer keys carry the oms_buy_ prefix; everything else stays on the x402 paywall. */
const PREPAID_BEARER = /^Bearer\s+oms_buy_/i;

export function shouldBypassPrepaid(req: Pick<Request, "method" | "path" | "get">): boolean {
  if (req.method !== "POST" || !req.path.startsWith("/api/v1/")) return false;
  return PREPAID_BEARER.test(req.get("authorization") ?? "");
}

const HOP_BY_HOP = new Set(["connection", "keep-alive", "content-length", "transfer-encoding"]);

/**
 * Returns true when the request was fully handled. False on a 401 from the
 * prepaid API: the key is fake/expired/revoked, so the request must fall
 * through to the standard x402 paywall instead of leaking the distinction.
 * Admin auth runs before any reserve/settle, so the fallback is side-effect free.
 */
export async function forwardPrepaidRequest(req: Request, res: Response): Promise<boolean> {
  const target = config.comboUpstreamBaseUrl + req.path.slice("/api/v1".length);
  const upstream = await fetch(target, {
    method: "POST",
    headers: {
      "content-type": req.get("content-type") ?? "application/json",
      authorization: req.get("authorization") ?? "",
      // The admin prepaid API is Host-gated to the apex domain; the gateway
      // deliberately presents itself as that boundary so prepaid keys behave
      // identically on every subdomain.
      "x-forwarded-host": "mapleai.shop",
      "user-agent": req.get("user-agent") ?? "mapleai-prepaid-bypass/1.0",
    },
    body: JSON.stringify(req.body ?? {}),
  });

  if (upstream.status === 401) {
    upstream.body?.cancel().catch(() => undefined);
    return false;
  }

  res.status(upstream.status);
  upstream.headers.forEach((value, name) => {
    if (!HOP_BY_HOP.has(name.toLowerCase())) res.setHeader(name, value);
  });

  if (!upstream.body) {
    res.end();
    return true;
  }
  const reader = upstream.body.getReader();
  req.once("close", () => {
    reader.cancel().catch(() => undefined);
  });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } finally {
    res.end();
  }
  return true;
}

export function prepaidBypassMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!shouldBypassPrepaid(req)) return next();
  forwardPrepaidRequest(req, res)
    .then((handled) => {
      // Fake/expired key: present the client with the normal pay-per-request challenge.
      if (!handled) next();
    })
    .catch((error: unknown) => {
      console.error("[prepaid-bypass] forward failed:", error instanceof Error ? error.message : "unknown");
      if (!res.headersSent) {
        res.status(502).json({ error: { message: "Prepaid gateway unavailable", type: "prepaid_bypass_error" } });
      } else {
        res.end();
      }
    });
}
