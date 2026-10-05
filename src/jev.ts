import type { NextFunction, Request, Response } from "express";
import { appendFileSync } from "node:fs";
import { config } from "./config.js";
import { paymentOverheadUsd } from "./gas.js";
import { get_encoding } from "tiktoken";

export const jevModel = "jev-latest";

function parsePrice(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error("JEV_INPUT_PRICE_PER_MILLION must be a positive number");
  return value;
}

export const jevPricePerMillion = parsePrice(process.env.JEV_INPUT_PRICE_PER_MILLION);
let encoder: ReturnType<typeof get_encoding> | undefined;
export function jevInputTokens(body: { state: unknown; questions: unknown }): number {
  encoder ??= get_encoding("o200k_base");
  return encoder.encode(JSON.stringify({ state: body.state, questions: body.questions })).length;
}
export const jevEnabled = Boolean(config.jevUpstreamApiKey && jevPricePerMillion);

export function validateJev(req: Request, res: Response, next: NextFunction): void {
  const body = req.body;
  const questions = body?.questions;
  if (!body || typeof body !== "object" || Array.isArray(body) || body.model !== jevModel ||
      typeof body.state !== "string" || body.state.trim().length === 0 ||
      !questions || typeof questions !== "object" || Array.isArray(questions) ||
      Object.keys(questions).length === 0 ||
      Object.entries(questions).some(([name, value]) => !name.trim() || !value ||
        typeof value !== "object" || Array.isArray(value) ||
        !["noul", "choice", "score"].includes((value as { type?: unknown }).type as string) ||
        typeof (value as { instructions?: unknown }).instructions !== "string" ||
        !(value as { instructions: string }).instructions.trim())) {
    res.status(400).json({ error: { message: "Expected model=jev-latest, nonempty state, and named questions with type and instructions", type: "invalid_request" } });
    return;
  }
  next();
}

export async function quoteJev(body: { state: unknown; questions: unknown }): Promise<string> {
  if (jevPricePerMillion === undefined) throw new Error("Jev price unavailable");
  const overhead = await paymentOverheadUsd();
  return "$" + Math.max(config.minChargeUsd, jevInputTokens(body) * jevPricePerMillion / 1_000_000 + overhead).toFixed(6);
}

export function fetchJev(body: unknown): Promise<globalThis.Response> {
  if (!config.jevUpstreamApiKey) throw new Error("Jev credential unavailable");
  return fetch(config.upstreamBaseUrl + "/systemone", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + config.jevUpstreamApiKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
}

type JevFailure = { source: "upstream" | "transport"; reason: string; message?: string };
const jevDataPreviewLimit = 64 * 1024;

function cappedJson(value: unknown): unknown {
  const text = JSON.stringify(value);
  if (text === undefined || text.length <= jevDataPreviewLimit) return value;
  return { truncated: true, preview: text.slice(0, jevDataPreviewLimit) };
}

export function recordJevData(entry: {
  domain: string;
  request: { state?: unknown; questions?: unknown };
  status: number;
  latencyMs: number;
  payer?: string;
  response?: unknown;
  failure?: JevFailure;
}): void {
  const event = {
    ts: new Date().toISOString(),
    domain: entry.domain,
    model: jevModel,
    status: entry.status,
    latencyMs: entry.latencyMs,
    ...(entry.payer ? { payer: entry.payer } : {}),
    request: { state: cappedJson(entry.request.state), questions: cappedJson(entry.request.questions) },
    ...(entry.response !== undefined ? { response: cappedJson(entry.response) } : {}),
    ...(entry.failure ? { failure: entry.failure } : {}),
  };
  try { appendFileSync(config.jevDataFile, JSON.stringify(event) + "\n", { mode: 0o600 }); }
  catch (error) { console.error("[jev] data log write failed:", error); }
}
