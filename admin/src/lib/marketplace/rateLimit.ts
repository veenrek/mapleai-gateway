// Lightweight in-process sliding-window rate limiter for marketplace auth
// endpoints. Defense-in-depth that pairs with edge/reverse-proxy limits — not a
// substitute. Single-process scope (same trade-off as src/server/auth/loginGuard.ts).
//
// Used to cap unauthenticated /auth/nonce and /auth/verify traffic per client so
// an attacker cannot flood the nonce table or brute-force signatures.

interface WindowState {
  count: number;
  windowStartMs: number;
}

const buckets = new Map<string, WindowState>();

// Opportunistic pruning so the map cannot grow without bound under distributed
// abuse (mirrors loginGuard's PRUNE_THRESHOLD approach).
const PRUNE_THRESHOLD = 1024;

function prune(now: number, windowMs: number): void {
  for (const [key, state] of buckets) {
    if (now - state.windowStartMs > windowMs) buckets.delete(key);
  }
}

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds?: number;
  remaining: number;
}

/**
 * Record one hit against `key` and return whether it is within `limit` per
 * `windowMs`. The window is fixed (resets after windowMs), which is sufficient
 * for coarse anti-abuse and cheap to compute.
 */
export function rateLimitHit(
  key: string,
  options: { limit: number; windowMs: number }
): RateLimitDecision {
  const now = Date.now();
  const { limit, windowMs } = options;

  if (buckets.size > PRUNE_THRESHOLD) prune(now, windowMs);

  const existing = buckets.get(key);
  if (!existing || now - existing.windowStartMs > windowMs) {
    buckets.set(key, { count: 1, windowStartMs: now });
    return { allowed: true, remaining: limit - 1 };
  }

  if (existing.count >= limit) {
    const retryAfterSeconds = Math.ceil((existing.windowStartMs + windowMs - now) / 1000);
    return { allowed: false, retryAfterSeconds, remaining: 0 };
  }

  existing.count += 1;
  return { allowed: true, remaining: limit - existing.count };
}

export function resetMarketplaceRateLimitForTests(): void {
  buckets.clear();
}

/** Test-only: number of tracked buckets. */
export function getMarketplaceRateLimitSizeForTests(): number {
  return buckets.size;
}
