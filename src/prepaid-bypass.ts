import type { NextFunction, Request, Response } from "express";
import { config } from "./config.js";
import { upstreamModelId } from "./models.js";

/** Marketplace prepaid buyer keys carry the oms_buy_ prefix; everything else stays on the x402 paywall. */
const PREPAID_BEARER = /^Bearer\s+oms_buy_/i;

type PrepaidRoute = {
  /** Suffix appended to the admin prepaid API base URL (COMBO_UPSTREAM_BASE_URL). */
  suffix: string;
  /**
   * true  (/api/v1/*): a missing or rejected buyer key falls through to the
   * standard x402 pay-per-request flow, so prepaid keys and one-off payments
   * share the same surface.
   * false (/prepaid/*): dedicated prepaid endpoints — answered on the spot,
   * there is no pay-per-request variant to fall back to.
   */
  paywallFallback: boolean;
};

function matchPrepaidRoute(req: Pick<Request, "method" | "path">): PrepaidRoute | null {
  if (req.method === "POST" && req.path.startsWith("/api/v1/")) {
    return { suffix: req.path.slice("/api/v1".length), paywallFallback: true };
  }
  if (req.method === "POST" && req.path.startsWith("/prepaid/v1/")) {
    return { suffix: req.path.slice("/prepaid/v1".length), paywallFallback: false };
  }
  if (req.method === "GET" && req.path === "/prepaid/status") {
    return { suffix: "/prepaid/status", paywallFallback: false };
  }
  return null;
}

export function shouldBypassPrepaid(req: Pick<Request, "method" | "path" | "get">): boolean {
  const route = matchPrepaidRoute(req);
  if (!route) return false;
  // GET /prepaid/status forwards with whatever Authorization was sent; the
  // admin API itself answers 401 when the bearer is missing or unknown.
  if (req.method !== "POST") return true;
  return PREPAID_BEARER.test(req.get("authorization") ?? "");
}

// content-encoding is stripped too: undici decompresses the upstream body
// transparently, so forwarding the original header would make clients gunzip
// an already-plain payload (Z_DATA_ERROR).
const HOP_BY_HOP = new Set(["connection", "keep-alive", "content-length", "transfer-encoding", "content-encoding"]);

/**
 * Returns true when the request was fully handled. False only for the
 * paywallFallback route on a 401 from the prepaid API: the key is
 * fake/expired/revoked, so the request must fall through to the standard x402
 * paywall instead of leaking the distinction. Admin auth runs before any
 * reserve/settle, so the fallback is side-effect free.
 */
export async function forwardPrepaidRequest(req: Request, res: Response, route: PrepaidRoute): Promise<boolean> {
  const target = config.comboUpstreamBaseUrl + route.suffix;
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  // Buyers think in our catalog ids (openai/..., anthropic/...); the prepaid
  // API addresses combos by their bare name (gpt-6-luna, claude-sonnet-5).
  // Normalize the model id the same way the chat proxy does.
  let outboundBody: unknown = req.body ?? {};
  if (hasBody && outboundBody && typeof outboundBody === "object" && !Array.isArray(outboundBody)) {
    const model = (outboundBody as { model?: unknown }).model;
    if (typeof model === "string") {
      const upstream = upstreamModelId(model);
      if (upstream !== model) outboundBody = { ...(outboundBody as Record<string, unknown>), model: upstream };
    }
  }
  const upstream = await fetch(target, {
    method: req.method,
    headers: {
      ...(hasBody ? { "content-type": req.get("content-type") ?? "application/json" } : {}),
      // Ask for plain bytes: the gateway relays the body to the client without
      // its own compression layer.
      "accept-encoding": "identity",
      authorization: req.get("authorization") ?? "",
      // The admin prepaid API is Host-gated to the apex domain; the gateway
      // deliberately presents itself as that boundary so prepaid keys behave
      // identically on every subdomain.
      "x-forwarded-host": "mapleai.shop",
      "user-agent": req.get("user-agent") ?? "mapleai-prepaid-bypass/1.0",
    },
    ...(hasBody ? { body: JSON.stringify(outboundBody) } : {}),
  });

  if (upstream.status === 401 && route.paywallFallback) {
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

function requestOrigin(req: Request): string {
  const host = req.get("host") ?? "mapleai.shop";
  return `https://${host}`;
}

/**
 * Helpful 401 for dedicated prepaid endpoints: besides telling that a key is
 * missing, show the caller EXACTLY how to use one and how to buy it. Same
 * shape as the usage block of a successful /prepaid/codes purchase.
 */
export function buildPrepaidRequiredBody(req: Request): Record<string, unknown> {
  const origin = requestOrigin(req);
  const body = (req as Request & { body?: Record<string, unknown> }).body ?? {};
  const exampleBody = Object.keys(body).length > 0
    ? body
    : req.path.endsWith("/chat/completions")
      ? { model: "openai/gpt-6-luna", messages: [{ role: "user", content: "Hello" }] }
      : body;
  return {
    error: {
      message: "A prepaid buyer key is required for this endpoint: send it as `Authorization: Bearer oms_buy_...`.",
      type: "prepaid_key_required",
    },
    usage: {
      authorization: "Bearer oms_buy_...",
      endpoint: `${req.method} ${origin}${req.path}`,
      example_curl:
        `curl -s ${origin}${req.path} -H "Authorization: Bearer oms_buy_..." ` +
        (Object.keys(exampleBody).length > 0 ? `-H "Content-Type: application/json" -d '${JSON.stringify(exampleBody)}'` : ""),
      buy_key: `POST ${origin}/prepaid/codes/auto  (x402 USDC, returns a fresh oms_buy_ key)`,
      status_check: `GET ${origin}/prepaid/status  (with the same Bearer; shows tokens total/used/remaining)`,
    },
  };
}

export function prepaidBypassMiddleware(req: Request, res: Response, next: NextFunction): void {
  const route = matchPrepaidRoute(req);
  if (!route) return next();
  if (!PREPAID_BEARER.test(req.get("authorization") ?? "")) {
    // Mixed /api/v1 surface keeps its pay-per-request fallback; dedicated
    // prepaid endpoints answer 401 themselves, with the usage example.
    if (route.paywallFallback) return next();
    res.status(401).json(buildPrepaidRequiredBody(req));
    return;
  }
  forwardPrepaidRequest(req, res, route)
    .then((handled) => {
      // Fake/expired key on /api/v1/*: present the client with the normal pay-per-request challenge.
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
