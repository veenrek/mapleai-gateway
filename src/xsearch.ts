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

export interface XSearchBody {
  query: string;
  max_results?: number;
  include_web?: boolean;
  instructions?: string;
  format?: "text" | "json";
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
    (body.instructions === undefined || typeof body.instructions === "string") &&
    (body.format === undefined || body.format === "text" || body.format === "json");
  if (!ok) {
    res.status(400).json({ error: {
      message: `Expected JSON body: {query: string (1-2000 chars), max_results?: 1..${maxResultsCap}, include_web?: boolean, instructions?: string, format?: "text" | "json"}`,
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
  const instructions =
    (typeof body.instructions === "string" && body.instructions.trim().length > 0
      ? body.instructions.trim() + "\n"
      : "") +
    (body.format === "json"
      ? `Search X (Twitter) for the query and return up to ${maxResults} of the most relevant posts. ` +
        "Reply ONLY with JSON of shape {posts:[{url,author,date,text,likes,reposts}]}: url is the direct post link, " +
        "author the @handle, date the post date (YYYY-MM-DD when known), text the post content verbatim " +
        "(trimmed to ~500 chars), likes/reposts integers when known."
      : `Search X (Twitter) and answer the query. Base the answer on posts found via x_search, ` +
        `and cite up to ${maxResults} of the most relevant posts with direct links.`);
  const payload = { model: xSearchModel, instructions, input: body.query, tools };
  return fetch(config.comboUpstreamBaseUrl + "/responses", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + config.internalComboKey },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(180_000),
  });
}

/** Parsed {posts: [...]} payload for format:"json" requests, or undefined when the model did not comply. */
export function parseXSearchJsonPosts(raw: string, extractJson: (text: string) => unknown): Record<string, unknown> | undefined {
  let body: { output_text?: string; output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }> };
  try { body = JSON.parse(raw); } catch { return undefined; }
  let text = typeof body.output_text === "string" ? body.output_text : "";
  if (text.trim().length === 0) {
    const parts: string[] = [];
    for (const item of body.output ?? []) {
      if (item?.type !== "message") continue;
      for (const part of item.content ?? []) {
        if (part?.type === "output_text" && typeof part.text === "string") parts.push(part.text);
      }
    }
    text = parts.join("\n");
  }
  const data = extractJson(text);
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  if (!Array.isArray((data as { posts?: unknown }).posts)) return undefined;
  return data as Record<string, unknown>;
}
