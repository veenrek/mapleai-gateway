import type { NextFunction, Request, Response } from "express";
import { appendFileSync } from "node:fs";
import { config } from "./config.js";
import { paymentOverheadUsd } from "./gas.js";
import { extractPayer, recordUsage } from "./ledger.js";

/**
 * Packaged X/Twitter intelligence endpoints (digest / sentiment / factcheck),
 * served through the admin combo router's Grok model with server-side tools
 * (x_search, web_search). Each endpoint validates input, quotes a price that
 * scales with the dominant upstream cost driver, runs one Responses call, and
 * verifies the model actually returned the promised JSON shape.
 */

function price(raw: string | undefined, name: string, fallback: number): number {
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(name + " must be a non-negative number");
  return value;
}

const xintelModel = process.env.X_SEARCH_COMBO_MODEL ?? "grok-4.6-search";
const xintelDataFile = process.env.X_INTEL_DATA_FILE ?? "./xintel-data.jsonl";

// --- shared upstream plumbing -------------------------------------------------

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function shiftDays(base: string, days: number): string {
  const d = new Date(base + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function dateWindow(days: number): { from_date: string; to_date: string } {
  const to = todayUtc();
  return { from_date: shiftDays(to, Math.max(0, days)), to_date: to };
}

function xSearchTool(extra?: Record<string, unknown>): Record<string, unknown> {
  return { type: "x_search", ...extra };
}

function runComboResponses(payload: Record<string, unknown>, timeoutMs: number): Promise<globalThis.Response> {
  if (!config.internalComboKey) throw new Error("Combo router credential missing");
  return fetch(config.comboUpstreamBaseUrl + "/responses", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + config.internalComboKey },
    body: JSON.stringify({ model: xintelModel, ...payload }),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/** Pull the first balanced JSON object out of model text (tolerates code fences). */
export function extractJson(text: string): unknown {
  const trimmed = text.replace(/```(?:json)?/gi, " ").trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

interface ComboResponse {
  output_text?: string;
  output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
  usage?: { input_tokens?: number; output_tokens?: number; server_side_tool_usage_details?: Record<string, number> };
  status?: string;
  error?: unknown;
}

/** Model text: top-level output_text, else the concatenated text of message items. */
function responseText(body: ComboResponse): string {
  if (typeof body.output_text === "string" && body.output_text.trim().length > 0) return body.output_text;
  const parts: string[] = [];
  for (const item of body.output ?? []) {
    if (item?.type !== "message") continue;
    for (const part of item.content ?? []) {
      if (part?.type === "output_text" && typeof part.text === "string") parts.push(part.text);
    }
  }
  return parts.join("\n");
}

interface XintelLogEntry {
  endpoint: string;
  meta: Record<string, unknown>;
  latencyMs: number;
  status: number;
  payer?: string;
  usage?: ComboResponse["usage"];
}

function recordXintel(entry: XintelLogEntry): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  try { appendFileSync(process.env.X_INTEL_DATA_FILE ?? xintelDataFile, line + "\n", { mode: 0o600 }); }
  catch (error) { console.error("[xintel] data log write failed:", error); }
}

/** Shared express handler: call combo, verify promised JSON shape, respond. */
async function handleXintel(
  req: Request,
  res: Response,
  ctx: {
    endpoint: string;
    object: string;
    timeoutMs: number;
    meta: Record<string, unknown>;
    payload: Record<string, unknown>;
    quoteUsd: string;
    check: (data: Record<string, unknown>) => boolean;
  },
): Promise<void> {
  const started = Date.now();
  const payer = extractPayer(req.get("payment-signature"));
  const log = (status: number, usage?: ComboResponse["usage"]) =>
    recordXintel({ endpoint: ctx.endpoint, meta: ctx.meta, latencyMs: Date.now() - started, status, payer, usage });
  try {
    const upstream = await runComboResponses(ctx.payload, ctx.timeoutMs);
    const raw = await upstream.text();
    if (!upstream.ok) {
      console.error(`[xintel:${ctx.endpoint}] combo router HTTP ` + upstream.status);
      log(upstream.status);
      res.status(upstream.status).type("application/json").send(raw);
      return;
    }
    let body: ComboResponse | undefined;
    try { body = JSON.parse(raw) as ComboResponse; } catch { body = undefined; }
    const data = body ? extractJson(responseText(body)) : undefined;
    if (!data || typeof data !== "object" || Array.isArray(data) || !ctx.check(data as Record<string, unknown>)) {
      console.error(`[xintel:${ctx.endpoint}] model returned invalid JSON shape`);
      log(502, body?.usage);
      res.status(502).json({ error: { message: "Search model returned an invalid structured response", type: "search_invalid_response" } });
      return;
    }
    log(200, body?.usage);
    recordUsage({
      ts: new Date().toISOString(), model: xintelModel, payer,
      upstreamStatus: upstream.status, quotedUsd: ctx.quoteUsd,
    });
    res.status(200).json({
      object: ctx.object,
      ...data,
      usage: body?.usage ?? null,
    });
  } catch (error) {
    console.error(`[xintel:${ctx.endpoint}] request failed:`, error instanceof Error ? error.name : "unknown");
    log(502);
    res.status(502).json({ error: { message: "Search request failed", type: "upstream_error" } });
  }
}

// --- /v1/x/digest --------------------------------------------------------------

export const digestBaseUsd = price(process.env.X_DIGEST_BASE_USD, "X_DIGEST_BASE_USD", 0.02);
export const digestPerHandleUsd = price(process.env.X_DIGEST_PER_HANDLE_USD, "X_DIGEST_PER_HANDLE_USD", 0.005);
export const digestMediaUsd = price(process.env.X_DIGEST_MEDIA_USD, "X_DIGEST_MEDIA_USD", 0.005);

interface DigestBody {
  handles: string[];
  hours_back?: number;
  max_posts_per_handle?: number;
  include_media?: boolean;
}

const handlePattern = /^[A-Za-z0-9_]{1,15}$/;

function normalizeHandles(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 20) return undefined;
  const out = raw.map((h) => (typeof h === "string" ? h.trim().replace(/^@/, "").toLowerCase() : ""));
  return out.every((h) => handlePattern.test(h)) ? out : undefined;
}

export function validateXDigest(req: Request, res: Response, next: NextFunction): void {
  const body = req.body;
  const handles = normalizeHandles(body?.handles);
  const ok =
    body && typeof body === "object" && !Array.isArray(body) && handles &&
    (body.hours_back === undefined || (Number.isInteger(body.hours_back) && body.hours_back >= 1 && body.hours_back <= 168)) &&
    (body.max_posts_per_handle === undefined ||
      (Number.isInteger(body.max_posts_per_handle) && body.max_posts_per_handle >= 1 && body.max_posts_per_handle <= 5)) &&
    (body.include_media === undefined || typeof body.include_media === "boolean");
  if (!ok) {
    res.status(400).json({ error: {
      message: "Expected JSON body: {handles: string[] (1..20 X handles), hours_back?: 1..168, max_posts_per_handle?: 1..5, include_media?: boolean}",
      type: "invalid_request",
    } });
    return;
  }
  body.handles = handles;
  next();
}

export function digestPrice(body: Pick<DigestBody, "handles" | "include_media">): number {
  return digestBaseUsd + digestPerHandleUsd * body.handles.length + (body.include_media ? digestMediaUsd : 0);
}

export async function quoteXDigest(body: Pick<DigestBody, "handles" | "include_media">): Promise<string> {
  const overhead = await paymentOverheadUsd();
  return "$" + Math.max(config.minChargeUsd, digestPrice(body) + overhead).toFixed(6);
}

export async function handleXDigest(req: Request, res: Response): Promise<void> {
  const body = req.body as DigestBody;
  const hoursBack = body.hours_back ?? 24;
  const perHandle = body.max_posts_per_handle ?? 3;
  const days = Math.ceil(hoursBack / 24);
  const dates = dateWindow(days);
  await handleXintel(req, res, {
    endpoint: "digest",
    object: "x.digest",
    timeoutMs: 300_000,
    meta: { handles: body.handles, hours_back: hoursBack, include_media: Boolean(body.include_media) },
    quoteUsd: await quoteXDigest(body),
    payload: {
      instructions:
        "Build a digest of recent X activity for the listed handles only (the search tool is already restricted to them). " +
        "Make exactly one x_search call per handle, ordered by relevance; do not fetch full threads. " +
        `For every handle report up to ${perHandle} key posts from the last ${hoursBack} hours with url, one-sentence summary, likes and reposts, ` +
        "plus 1-3 recurring themes. Mark a handle silent when it posted nothing relevant. " +
        "Reply ONLY with JSON of shape {handles:[{handle,silent,themes,posts:[{url,summary,likes,reposts}]}]}.",
      input: "Handles: " + body.handles.join(", "),
      tools: [xSearchTool({
        allowed_x_handles: body.handles,
        ...dates,
        ...(body.include_media ? { enable_image_understanding: true } : {}),
      })],
    },
    check: (d) => Array.isArray(d.handles),
  });
}

// --- /v1/x/sentiment -----------------------------------------------------------

export const sentimentBaseUsd = price(process.env.X_SENTIMENT_BASE_USD, "X_SENTIMENT_BASE_USD", 0.025);
export const sentimentPerExampleUsd = price(process.env.X_SENTIMENT_PER_EXAMPLE_USD, "X_SENTIMENT_PER_EXAMPLE_USD", 0.0015);
export const sentimentPerDayUsd = price(process.env.X_SENTIMENT_PER_DAY_USD, "X_SENTIMENT_PER_DAY_USD", 0.005);

interface SentimentBody {
  topic: string;
  hours_back?: number;
  max_examples?: number;
  min_engagement?: number;
}

export function validateXSentiment(req: Request, res: Response, next: NextFunction): void {
  const body = req.body;
  const ok =
    body && typeof body === "object" && !Array.isArray(body) &&
    typeof body.topic === "string" && body.topic.trim().length > 0 && body.topic.length <= 200 &&
    (body.hours_back === undefined || (Number.isInteger(body.hours_back) && body.hours_back >= 1 && body.hours_back <= 168)) &&
    (body.max_examples === undefined || (Number.isInteger(body.max_examples) && body.max_examples >= 1 && body.max_examples <= 10)) &&
    (body.min_engagement === undefined || (Number.isInteger(body.min_engagement) && body.min_engagement >= 0));
  if (!ok) {
    res.status(400).json({ error: {
      message: "Expected JSON body: {topic: string (1..200), hours_back?: 1..168, max_examples?: 1..10, min_engagement?: int >= 0}",
      type: "invalid_request",
    } });
    return;
  }
  next();
}

export function sentimentPrice(body: Partial<SentimentBody>): number {
  const examples = typeof body.max_examples === "number" ? body.max_examples : 5;
  const hoursBack = typeof body.hours_back === "number" ? body.hours_back : 24;
  const days = Math.ceil(hoursBack / 24);
  return sentimentBaseUsd + sentimentPerExampleUsd * examples + sentimentPerDayUsd * Math.max(0, days - 1);
}

export async function quoteXSentiment(body: Partial<SentimentBody>): Promise<string> {
  const overhead = await paymentOverheadUsd();
  return "$" + Math.max(config.minChargeUsd, sentimentPrice(body) + overhead).toFixed(6);
}

export async function handleXSentiment(req: Request, res: Response): Promise<void> {
  const body = req.body as SentimentBody;
  const hoursBack = body.hours_back ?? 24;
  const maxExamples = body.max_examples ?? 5;
  const days = Math.ceil(hoursBack / 24);
  const dates = dateWindow(days);
  await handleXintel(req, res, {
    endpoint: "sentiment",
    object: "x.sentiment",
    timeoutMs: 240_000,
    meta: { topic: body.topic.slice(0, 200), hours_back: hoursBack, min_engagement: body.min_engagement ?? 0 },
    quoteUsd: await quoteXSentiment(body),
    payload: {
      instructions:
        "Assess the current X sentiment around the topic. Make exactly two x_search calls: one keyword search in mode Top " +
        "and one in mode Latest" +
        ((body.min_engagement ?? 0) > 0 ? `, both with the operator min_faves:${body.min_engagement}` : "") +
        ". Read every fetched post and classify each as bullish, bearish or neutral about the topic. " +
        `Reply ONLY with JSON of shape {topic,verdict,score,distribution:{bullish,bearish,neutral},posts_evaluated,drivers,examples:[{url,stance,snippet,likes}]} ` +
        `where verdict is bullish|bearish|neutral|mixed, score is -1..1, drivers are <=5 short strings, and examples has at most ${maxExamples} representative posts. `,
      input: `Topic: ${body.topic}. Window: last ${hoursBack} hours.`,
      tools: [xSearchTool(dates)],
    },
    check: (d) =>
      ["bullish", "bearish", "neutral", "mixed"].includes(d.verdict as string) &&
      typeof d.score === "number" && Array.isArray(d.examples),
  });
}

// --- /v1/x/factcheck -----------------------------------------------------------

export const factcheckBaseUsd = price(process.env.X_FACTCHECK_BASE_USD, "X_FACTCHECK_BASE_USD", 0.03);
export const factcheckPerSourceUsd = price(process.env.X_FACTCHECK_PER_SOURCE_USD, "X_FACTCHECK_PER_SOURCE_USD", 0.002);

interface FactcheckBody {
  claim: string;
  max_sources?: number;
  days_back?: number;
}

export function validateXFactcheck(req: Request, res: Response, next: NextFunction): void {
  const body = req.body;
  const ok =
    body && typeof body === "object" && !Array.isArray(body) &&
    typeof body.claim === "string" && body.claim.trim().length > 0 && body.claim.length <= 1000 &&
    (body.max_sources === undefined || (Number.isInteger(body.max_sources) && body.max_sources >= 1 && body.max_sources <= 10)) &&
    (body.days_back === undefined || (Number.isInteger(body.days_back) && body.days_back >= 1 && body.days_back <= 30));
  if (!ok) {
    res.status(400).json({ error: {
      message: "Expected JSON body: {claim: string (1..1000), max_sources?: 1..10, days_back?: 1..30}",
      type: "invalid_request",
    } });
    return;
  }
  next();
}

export function factcheckPrice(body: Partial<FactcheckBody>): number {
  const sources = typeof body.max_sources === "number" ? body.max_sources : 6;
  return factcheckBaseUsd + factcheckPerSourceUsd * sources;
}

export async function quoteXFactcheck(body: Partial<FactcheckBody>): Promise<string> {
  const overhead = await paymentOverheadUsd();
  return "$" + Math.max(config.minChargeUsd, factcheckPrice(body) + overhead).toFixed(6);
}

export async function handleXFactcheck(req: Request, res: Response): Promise<void> {
  const body = req.body as FactcheckBody;
  const daysBack = body.days_back ?? 7;
  const maxSources = body.max_sources ?? 6;
  const dates = dateWindow(daysBack);
  await handleXintel(req, res, {
    endpoint: "factcheck",
    object: "x.factcheck",
    timeoutMs: 240_000,
    meta: { claim: body.claim.slice(0, 1000), days_back: daysBack },
    quoteUsd: await quoteXFactcheck(body),
    payload: {
      instructions:
        "Factcheck the claim using both tools: x_search for what people on X say and web_search for press/official sources. " +
        "If no relevant material exists, verdict must be unverified and evidence lists may be empty. " +
        `Reply ONLY with JSON of shape {claim,verdict,confidence,summary,evidence_for:[{url,source_type,note}],evidence_against:[{url,source_type,note}]} ` +
        `where verdict is confirmed|refuted|mixed|unverified, confidence is low|medium|high, source_type is x|web, and each evidence list holds at most ${maxSources} items.`,
      input: `Claim: ${body.claim}. Window: last ${daysBack} days.`,
      tools: [xSearchTool(dates), { type: "web_search" }],
    },
    check: (d) =>
      ["confirmed", "refuted", "mixed", "unverified"].includes(d.verdict as string) &&
      Array.isArray(d.evidence_for) && Array.isArray(d.evidence_against),
  });
}
