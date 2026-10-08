import type { NextFunction, Request, Response } from "express";

/**
 * Informational body for the otherwise-empty 402 JSON response. The
 * payment-required header stays authoritative; the body is what curl users
 * and catalog crawlers can read, so it points at the free tier, live
 * pricing, the developer docs and the agent starter repository.
 */
export interface PaymentRequiredBodyFlags {
  embeddingsEnabled: boolean;
  freeGptOssEnabled: boolean;
}

export function buildPaymentRequiredBody(
  origin: string,
  flags: PaymentRequiredBodyFlags,
  paymentRequiredHeader?: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    error: "Payment required",
    pricing_transparency: `${origin}/v1/models`,
    docs: `${origin}/developers`,
    agent_starter: "https://github.com/veenrek/mapleai-agent-starter",
  };
  const free: Record<string, string> = {};
  if (flags.embeddingsEnabled) free.embeddings = `${origin}/v1/embeddings`;
  if (flags.freeGptOssEnabled) free.chat = `${origin}/v1/free/chat/completions`;
  if (Object.keys(free).length > 0) {
    body.free_trial = { description: "Free endpoints, no key and no account", ...free };
  }
  if (paymentRequiredHeader) {
    try {
      const decoded = JSON.parse(Buffer.from(paymentRequiredHeader, "base64").toString("utf8")) as {
        extensions?: unknown;
      };
      if (decoded.extensions && typeof decoded.extensions === "object") body.extensions = decoded.extensions;
    } catch {
      /* malformed header: the informational body just skips the mirror */
    }
  }
  return body;
}

function isEmptyJsonBody(body: unknown): boolean {
  return body === undefined || body === null ||
    (typeof body === "object" && !Array.isArray(body) && Object.keys(body as object).length === 0);
}

/**
 * The x402 middleware answers 402 with an empty `{}` JSON body; swap that
 * body for the informational one. Non-empty bodies pass through untouched.
 */
export function paymentRequiredBodyMiddleware(
  flags: PaymentRequiredBodyFlags,
  originOf: (req: Request) => string,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const json = res.json.bind(res);
    res.json = ((body?: unknown) => {
      if (res.statusCode === 402 && isEmptyJsonBody(body)) {
        const header = res.getHeader("payment-required");
        return json(buildPaymentRequiredBody(originOf(req), flags, typeof header === "string" ? header : undefined));
      }
      return json(body);
    }) as Response["json"];
    next();
  };
}
