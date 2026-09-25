import { CORS_HEADERS } from "@/shared/utils/cors";

export function marketplaceJson(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
}

export function marketplaceError(status: number, message: string, code = "marketplace_error") {
  return marketplaceJson(
    {
      error: {
        message,
        type: code,
      },
    },
    { status }
  );
}

/** 429 response with an optional Retry-After header. */
export function marketplaceRateLimited(retryAfterSeconds?: number) {
  return marketplaceJson(
    { error: { message: "Too many requests", type: "rate_limited" } },
    {
      status: 429,
      headers: retryAfterSeconds ? { "Retry-After": String(retryAfterSeconds) } : {},
    }
  );
}
