import type { Request, Response } from "express";
import { appendFileSync } from "node:fs";
import { config } from "./config.js";

export const freeGptOssModel = "nvidia/gpt-oss-20b";
const comboModel = "gpt-oss-20b";

const dataFile = process.env.FREE_OSS_DATA_FILE ?? "./free-oss-data.jsonl";
const previewLimit = 64 * 1024;

function cappedJson(value: unknown): unknown {
  const text = JSON.stringify(value);
  if (text === undefined || text.length <= previewLimit) return value;
  return { truncated: true, preview: text.slice(0, previewLimit) };
}

/** Private operator log for the free tier: request bodies + outcomes, mode 0600, never public. */
export function recordFreeOssData(entry: {
  domain: string;
  clientIp: string;
  request: { messages?: unknown; stream?: boolean; max_tokens?: unknown };
  status: number;
  latencyMs: number;
  response?: unknown;
  failure?: { source: "validation" | "quota" | "upstream" | "transport"; reason: string };
}): void {
  const event = {
    ts: new Date().toISOString(),
    domain: entry.domain,
    model: freeGptOssModel,
    clientIp: entry.clientIp,
    status: entry.status,
    latencyMs: entry.latencyMs,
    request: {
      stream: entry.request.stream === true,
      max_tokens: cappedJson(entry.request.max_tokens),
      messages: cappedJson(entry.request.messages),
    },
    ...(entry.response !== undefined ? { response: cappedJson(entry.response) } : {}),
    ...(entry.failure ? { failure: entry.failure } : {}),
  };
  try { appendFileSync(dataFile, JSON.stringify(event) + "\n", { mode: 0o600 }); }
  catch (error) { console.error("[free-gptoss] data log write failed:", error); }
}

export const freeGptOssEnabled =
  Boolean(config.internalOssKey) && config.freeGptOssPer10Min > 0 && config.freeGptOssPerDay > 0;

type Bucket = { minute: number[]; day: number[] };
const buckets = new Map<string, Bucket>();

function clientIp(req: Request): string {
  return (
    (req.get("cf-connecting-ip") ?? req.get("x-forwarded-for")?.split(",")[0]?.trim() ?? req.socket.remoteAddress) ??
    "unknown"
  ).slice(0, 80);
}

const TEN_MIN = 10 * 60_000;
const DAY = 24 * 60 * 60_000;

/**
 * Per-agent (IP-keyed) sliding-window quota for the free gpt-oss-20b tier.
 * 10 requests per 10 minutes and 100 per 24 hours by default — bursts pass,
 * sustained spam stops. Pure in-memory: a restart resets the window, which is
 * acceptable for a free tier.
 */
export function checkFreeQuota(ip: string, now = Date.now()): { ok: true; remaining10m: number; remainingDay: number } | { ok: false; retryAfterSec: number } {
  let bucket = buckets.get(ip);
  if (!bucket) { bucket = { minute: [], day: [] }; buckets.set(ip, bucket); }
  bucket.minute = bucket.minute.filter((t) => now - t < TEN_MIN);
  bucket.day = bucket.day.filter((t) => now - t < DAY);
  if (bucket.minute.length >= config.freeGptOssPer10Min) {
    return { ok: false, retryAfterSec: Math.ceil((bucket.minute[0] + TEN_MIN - now) / 1000) };
  }
  if (bucket.day.length >= config.freeGptOssPerDay) {
    return { ok: false, retryAfterSec: Math.ceil((bucket.day[0] + DAY - now) / 1000) };
  }
  bucket.minute.push(now);
  bucket.day.push(now);
  return {
    ok: true,
    remaining10m: config.freeGptOssPer10Min - bucket.minute.length,
    remainingDay: config.freeGptOssPerDay - bucket.day.length,
  };
}

export function freeQuotaSnapshot(ip: string, now = Date.now()): { per10Min: { limit: number; used: number }; perDay: { limit: number; used: number } } {
  const bucket = buckets.get(ip);
  const minute = bucket ? bucket.minute.filter((t) => now - t < TEN_MIN).length : 0;
  const day = bucket ? bucket.day.filter((t) => now - t < DAY).length : 0;
  return {
    per10Min: { limit: config.freeGptOssPer10Min, used: minute },
    perDay: { limit: config.freeGptOssPerDay, used: day },
  };
}

const modelRewriteFrom = /"model":"[^"]*"/g;

/** Free gpt-oss-20b chat — combo-routed across the NVIDIA account pool, rate-limited per agent. */
export async function handleFreeGptOssChat(req: Request, res: Response): Promise<void> {
  const started = Date.now();
  const domain = req.get("host") ?? "unknown";
  const ipEarly = clientIp(req);
  const logReq = () => ({
    domain,
    clientIp: ipEarly,
    request: { messages: (req.body as { messages?: unknown })?.messages, stream: (req.body as { stream?: unknown })?.stream === true, max_tokens: (req.body as { max_tokens?: unknown })?.max_tokens },
  });

  const body = req.body as Record<string, unknown> | undefined;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    recordFreeOssData({ ...logReq(), status: 400, latencyMs: Date.now() - started, failure: { source: "validation", reason: "non_object_body" } });
    res.status(400).json({ error: { message: "JSON body required", type: "invalid_request" } });
    return;
  }
  const requested = typeof body.model === "string" ? body.model : freeGptOssModel;
  if (requested !== freeGptOssModel && requested !== comboModel) {
    recordFreeOssData({ ...logReq(), status: 400, latencyMs: Date.now() - started, failure: { source: "validation", reason: "unsupported_model" } });
    res.status(400).json({
      error: {
        message: `This free endpoint serves ${freeGptOssModel} only; see GET /v1/models for paid models.`,
        type: "invalid_request",
        details: { allowedModel: freeGptOssModel },
      },
    });
    return;
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    recordFreeOssData({ ...logReq(), status: 400, latencyMs: Date.now() - started, failure: { source: "validation", reason: "missing_messages" } });
    res.status(400).json({ error: { message: "messages[] required", type: "invalid_request" } });
    return;
  }

  if (typeof body.max_tokens === "number" && body.max_tokens > config.freeGptOssMaxTokens) {
    body.max_tokens = config.freeGptOssMaxTokens;
  } else if (body.max_tokens === undefined) {
    body.max_tokens = config.freeGptOssMaxTokens;
  }
  const wantsStream = body.stream === true;
  body.stream = wantsStream;
  if (wantsStream) body.stream_options = { include_usage: true };

  const ip = clientIp(req);
  const quota = checkFreeQuota(ip);
  res.setHeader("x-ratelimit-limit-10min", config.freeGptOssPer10Min);
  res.setHeader("x-ratelimit-limit-day", config.freeGptOssPerDay);
  if (!quota.ok) {
    res.setHeader("retry-after", quota.retryAfterSec);
    recordFreeOssData({ ...logReq(), status: 429, latencyMs: Date.now() - started, failure: { source: "quota", reason: "free_tier_exhausted" } });
    res.status(429).json({
      error: {
        message: `free tier limit reached (${config.freeGptOssPer10Min}/10min or ${config.freeGptOssPerDay}/day per agent). Retry after the window resets, or use the paid models via x402 (see /v1/models).`,
        type: "rate_limit_exceeded",
        code: "free_tier_exhausted",
        retryAfterSec: quota.retryAfterSec,
      },
    });
    return;
  }
  if (quota.remaining10m !== undefined) res.setHeader("x-ratelimit-remaining-10min", quota.remaining10m);
  if (quota.remainingDay !== undefined) res.setHeader("x-ratelimit-remaining-day", quota.remainingDay);

  try {
    const upstream = await fetch(config.comboUpstreamBaseUrl + "/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + config.internalOssKey },
      body: JSON.stringify({ ...body, model: comboModel }),
      signal: AbortSignal.timeout(180_000),
    });

    if (!wantsStream) {
      const text = await upstream.text();
      let out = text;
      if (upstream.ok) {
        try {
          const parsed = JSON.parse(text) as Record<string, unknown>;
          parsed.model = freeGptOssModel;
          out = JSON.stringify(parsed);
        } catch { /* pass through */ }
      }
      recordFreeOssData({
        ...logReq(), status: upstream.status, latencyMs: Date.now() - started,
        response: upstream.ok ? out : undefined,
        ...(upstream.ok ? {} : { failure: { source: "upstream" as const, reason: "upstream_http_" + upstream.status } }),
      });
      res.status(upstream.status).type("application/json").send(out);
      return;
    }

    res.status(upstream.status);
    res.setHeader("content-type", "text/event-stream; charset=utf-8");
    res.setHeader("cache-control", "no-cache, no-transform");
    res.setHeader("x-accel-buffering", "no");
    if (!upstream.body) { res.end(); return; }
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let carry = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = carry + decoder.decode(value, { stream: true });
        const lines = text.split("\n");
        carry = lines.pop() ?? "";
        for (const line of lines) res.write(line.replace(modelRewriteFrom, `"model":"${freeGptOssModel}"`) + "\n");
      }
      if (carry) res.write(carry.replace(modelRewriteFrom, `"model":"${freeGptOssModel}"`));
      recordFreeOssData({
        ...logReq(), status: upstream.status, latencyMs: Date.now() - started,
        response: { streamed: true },
        ...(upstream.ok ? {} : { failure: { source: "upstream" as const, reason: "upstream_http_" + upstream.status } }),
      });
    } finally {
      res.end();
    }
  } catch (error) {
    console.error("[free-gptoss] upstream error:", error instanceof Error ? error.name : "unknown");
    recordFreeOssData({ ...logReq(), status: 502, latencyMs: Date.now() - started, failure: { source: "transport", reason: error instanceof Error ? error.name : "unknown" } });
    res.status(502).json({ error: { message: "free tier upstream temporarily unavailable", type: "upstream_error" } });
  }
}
