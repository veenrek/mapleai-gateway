import type { NextFunction, Request, Response } from "express";
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
      body.state === undefined || body.state === null ||
      !questions || typeof questions !== "object" || Array.isArray(questions) ||
      !["noul", "choice", "score"].some((kind) => Object.hasOwn(questions, kind))) {
    res.status(400).json({ error: { message: "Expected model=jev-latest, state and questions with noul, choice or score", type: "invalid_request" } });
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
