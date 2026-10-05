import type { NextFunction, Request, Response } from "express";
import { config } from "./config.js";
import { paymentOverheadUsd } from "./gas.js";

/** Live web search via the admin combo router (Grok web_search tool). */
export const webSearchModel = process.env.X_SEARCH_COMBO_MODEL ?? "grok-4.6-search";

function parsePrice(raw: string | undefined, name: string): number | undefined {
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(name + " must be a positive number");
  return value;
}

export const webSearchBaseUsd = parsePrice(process.env.X_WEB_BASE_PRICE_USD, "X_WEB_BASE_PRICE_USD") ?? 0.015;
export const webSearchPerResultUsd = parsePrice(process.env.X_WEB_PER_RESULT_USD, "X_WEB_PER_RESULT_USD") ?? 0.001;

const webMaxResultsCap = 25;

const domainPattern = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i;

export interface WebSearchBody {
  query: string;
  max_results?: number;
  instructions?: string;
  allowed_domains?: string[];
}

export function validateWebSearch(req: Request, res: Response, next: NextFunction): void {
  const body = req.body;
  const domainsOk =
    body?.allowed_domains === undefined ||
    (Array.isArray(body.allowed_domains) && body.allowed_domains.length >= 1 && body.allowed_domains.length <= 5 &&
      body.allowed_domains.every((d: unknown) => typeof d === "string" && domainPattern.test(d)));
  const ok =
    body && typeof body === "object" && !Array.isArray(body) &&
    typeof body.query === "string" && body.query.trim().length > 0 && body.query.length <= 2000 &&
    (body.max_results === undefined ||
      (Number.isInteger(body.max_results) && body.max_results >= 1 && body.max_results <= webMaxResultsCap)) &&
    (body.instructions === undefined || typeof body.instructions === "string") &&
    domainsOk;
  if (!ok) {
    res.status(400).json({ error: {
      message: `Expected JSON body: {query: string (1-2000 chars), max_results?: 1..${webMaxResultsCap}, instructions?: string, allowed_domains?: up to 5 domains}`,
      type: "invalid_request",
    } });
    return;
  }
  next();
}

export function webSearchPriceFor(body: Partial<WebSearchBody>): number {
  const maxResults = typeof body.max_results === "number" ? body.max_results : 10;
  return webSearchBaseUsd + webSearchPerResultUsd * maxResults;
}

export async function quoteWebSearch(body: Partial<WebSearchBody>): Promise<string> {
  const overhead = await paymentOverheadUsd();
  return "$" + Math.max(config.minChargeUsd, webSearchPriceFor(body) + overhead).toFixed(6);
}

export function fetchWebSearch(body: WebSearchBody): Promise<globalThis.Response> {
  if (!config.internalComboKey) throw new Error("Combo router credential missing");
  const maxResults = body.max_results ?? 10;
  const payload = {
    model: webSearchModel,
    instructions:
      (typeof body.instructions === "string" && body.instructions.trim().length > 0
        ? body.instructions.trim() + "\n"
        : "") +
      `Search the web and answer the query. Base the answer on pages found via web_search, ` +
      `and cite up to ${maxResults} of the most relevant sources with direct links.`,
    input: body.query,
    tools: [
      { type: "web_search", ...(Array.isArray(body.allowed_domains) ? { allowed_domains: body.allowed_domains } : {}) },
    ],
  };
  return fetch(config.comboUpstreamBaseUrl + "/responses", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + config.internalComboKey },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(120_000),
  });
}
