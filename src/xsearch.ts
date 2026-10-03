import type { NextFunction, Request, Response } from "express";
import { config } from "./config.js";
import { paymentOverheadUsd } from "./gas.js";

/** Live X/Twitter search via the admin combo router (Grok model + x_search tool). */
export const xSearchModel = process.env.X_SEARCH_COMBO_MODEL ?? "grok-4.6-search";

function parsePrice(raw: string | undefined, name: string): number | undefined {
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(name + " must be a positive number");
  return value;
}

/** Base covers the model tokens; the dominant upstream cost is the server-side
 *  x_search tool, which scales with fetched posts — so price scales with max_results. */
export const xSearchBasePriceUsd = parsePrice(process.env.X_SEARCH_BASE_PRICE_USD, "X_SEARCH_BASE_PRICE_USD") ?? 0.015;
export const xSearchPerResultUsd = parsePrice(process.env.X_SEARCH_PER_RESULT_USD, "X_SEARCH_PER_RESULT_USD") ?? 0.0015;
export const xSearchWebPriceUsd = parsePrice(process.env.X_SEARCH_WEB_PRICE_USD, "X_SEARCH_WEB_PRICE_USD") ?? 0.01;
export const xSearchEnabled = Boolean(config.internalComboKey);

const maxResultsCap = 25;

interface XSearchBody {
  query: string;
  max_results?: number;
  include_web?: boolean;
  instructions?: string;
}

export function xSearchPriceFor(body: Partial<XSearchBody>): number {
  const maxResults = typeof body.max_results === "number" ? body.max_results : 10;
  return xSearchBasePriceUsd + xSearchPerResultUsd * maxResults + (body.include_web ? xSearchWebPriceUsd : 0);
}

export function validateXSearch(req: Request, res: Response, next: NextFunction): void {
  const body = req.body;
  const ok =
    body && typeof body === "object" && !Array.isArray(body) &&
    typeof body.query === "string" && body.query.trim().length > 0 && body.query.length <= 2000 &&
    (body.max_results === undefined ||
      (Number.isInteger(body.max_results) && body.max_results >= 1 && body.max_results <= maxResultsCap)) &&
    (body.include_web === undefined || typeof body.include_web === "boolean") &&
    (body.instructions === undefined || typeof body.instructions === "string");
  if (!ok) {
    res.status(400).json({ error: {
      message: `Expected JSON body: {query: string (1-2000 chars), max_results?: 1..${maxResultsCap}, include_web?: boolean, instructions?: string}`,
      type: "invalid_request",
    } });
    return;
  }
  next();
}

export async function quoteXSearch(body: Partial<XSearchBody>): Promise<string> {
  const overhead = await paymentOverheadUsd();
  return "$" + Math.max(config.minChargeUsd, xSearchPriceFor(body) + overhead).toFixed(6);
}

export function fetchXSearch(body: XSearchBody): Promise<globalThis.Response> {
  if (!config.internalComboKey) throw new Error("Combo router credential missing");
  const tools: Array<Record<string, unknown>> = [{ type: "x_search" }];
  if (body.include_web) tools.push({ type: "web_search" });
  const maxResults = body.max_results ?? 10;
  const payload = {
    model: xSearchModel,
    instructions:
      (typeof body.instructions === "string" && body.instructions.trim().length > 0
        ? body.instructions.trim() + "\n"
        : "") +
      `Search X (Twitter) and answer the query. Base the answer on posts found via x_search, ` +
      `and cite up to ${maxResults} of the most relevant posts with direct links.`,
    input: body.query,
    tools,
  };
  return fetch(config.comboUpstreamBaseUrl + "/responses", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + config.internalComboKey },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(180_000),
  });
}
