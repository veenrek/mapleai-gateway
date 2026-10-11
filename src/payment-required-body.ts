import type { NextFunction, Request, Response } from "express";
import { createHmac } from "node:crypto";

/**
 * Informational body for the otherwise-empty 402 JSON response. The
 * payment-required header stays authoritative; the body is what curl users
 * and catalog crawlers can read, so it points at the free tier, live
 * pricing, the developer docs and the agent starter repository.
 *
 * The middleware also mirrors the x402 challenge as an MPP (Machine Payments
 * Protocol, draft-ryan-httpauth-payment) `WWW-Authenticate: Payment` header.
 * Both protocols ride the same 402: x402 clients read PAYMENT-REQUIRED, MPP
 * clients and agent-discovery crawlers read WWW-Authenticate; each ignores
 * the other (RFC 9110 allows stacked challenges).
 */

/** EVM chain id parsed from an eip155:NNN network id; Solana entries are skipped (MPP usdc method profiles EVM here). */
function evmChainId(network: string): number | null {
  const m = /^eip155:(\d+)$/.exec(network);
  return m ? Number(m[1]) : null;
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}

/**
 * Build one MPP challenge per EVM entry of the x402 accepts[] found in the
 * PAYMENT-REQUIRED header. `request` is base64url(no-pad) of JCS-canonical
 * JSON — our keys are written alphabetically, which satisfies RFC 8785 for
 * these plain objects. `id` is an HMAC binding over all other params (secret
 * falls back to a payTo-derived key: integrity binding only, we never verify
 * MPP credentials today — this is a discovery signal, not MPP acceptance).
 */
export function buildMppChallenges(paymentRequiredHeader: string, realm: string, secret: string): string[] {
  let decoded: { accepts?: { network?: string; asset?: string; payTo?: string; amount?: string; extra?: Record<string, unknown> }[] };
  try {
    decoded = JSON.parse(Buffer.from(paymentRequiredHeader, "base64").toString("utf8"));
  } catch {
    return [];
  }
  const expires = new Date(Date.now() + 5 * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const key = secret || "mapleai-mpp-binding-v1:" + realm;
  const challenges: string[] = [];
  for (const accept of decoded.accepts ?? []) {
    const chainId = evmChainId(accept.network ?? "");
    if (chainId === null || !accept.asset || !accept.payTo || !accept.amount || !/^[1-9][0-9]*$/.test(accept.amount)) continue;
    const description = typeof accept.extra?.description === "string" ? accept.extra.description : "API request paid per call";
    // Alphabetical key order == JCS canonicalization for this plain shape.
    const requestJson = JSON.stringify({
      amount: accept.amount,
      currency: accept.asset,
      description,
      methodDetails: { chainId, credentialTypes: ["authorization"] },
      recipient: accept.payTo,
    });
    const request = b64url(requestJson);
    const id = b64url(
      createHmac("sha256", key).update([realm, "usdc", "charge", expires, request].join("|")).digest(),
    ).slice(0, 24);
    challenges.push(
      `Payment id="${id}", realm="${realm}", method="usdc", intent="charge", expires="${expires}", request="${request}"`,
    );
  }
  return challenges;
}
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
  mppSecret = "",
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const json = res.json.bind(res);
    res.json = ((body?: unknown) => {
      if (res.statusCode === 402 && isEmptyJsonBody(body)) {
        const header = res.getHeader("payment-required");
        if (typeof header === "string") {
          const mpp = buildMppChallenges(header, originOf(req).replace(/^https?:\/\//, ""), mppSecret);
          if (mpp.length === 1) res.setHeader("WWW-Authenticate", mpp[0]);
          else if (mpp.length > 1) res.setHeader("WWW-Authenticate", mpp);
        }
        return json(buildPaymentRequiredBody(originOf(req), flags, typeof header === "string" ? header : undefined));
      }
      return json(body);
    }) as Response["json"];
    next();
  };
}
