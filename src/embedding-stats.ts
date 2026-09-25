import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { config } from "./config.js";

type EmbeddingEvent = { ts: string; domain: string; model?: string; status: number; latencyMs: number };
type Bucket = { requests: number; successful: number; errors: number };
type Stats = { total: number; successful: number; errors: number; byDomain: Record<string, Bucket>; byModel: Record<string, Bucket>; recent: EmbeddingEvent[] };

const stats: Stats = { total: 0, successful: 0, errors: 0, byDomain: {}, byModel: {}, recent: [] };
const recentLimit = 100;

function bucket(map: Record<string, Bucket>, key: string): Bucket {
  return map[key] ??= { requests: 0, successful: 0, errors: 0 };
}
function add(event: EmbeddingEvent, persist: boolean): void {
  stats.total += 1;
  const ok = event.status >= 200 && event.status < 300;
  if (ok) stats.successful += 1; else stats.errors += 1;
  for (const map of [stats.byDomain, stats.byModel]) {
    const key = map === stats.byDomain ? event.domain : (event.model ?? "unknown");
    const item = bucket(map, key); item.requests += 1; if (ok) item.successful += 1; else item.errors += 1;
  }
  stats.recent.push(event); if (stats.recent.length > recentLimit) stats.recent.splice(0, stats.recent.length - recentLimit);
  if (persist) { try { appendFileSync(config.embeddingStatsFile, JSON.stringify(event) + "\n", { mode: 0o600 }); } catch (error) { console.error("[embeddings] stats write failed:", error); } }
}

if (existsSync(config.embeddingStatsFile)) {
  try { for (const line of readFileSync(config.embeddingStatsFile, "utf8").split(/\r?\n/).filter(Boolean).slice(-recentLimit)) { const event = JSON.parse(line) as EmbeddingEvent; if (event && typeof event.domain === "string" && typeof event.status === "number") add(event, false); } }
  catch (error) { console.error("[embeddings] stats load failed:", error); }
}

export function trackEmbeddingRequest(req: { get(name: string): string | undefined; body?: { model?: unknown } }, res: { statusCode: number; once(event: string, callback: () => void): void }): void {
  const started = Date.now();
  res.once("finish", () => add({ ts: new Date().toISOString(), domain: req.get("host") ?? "unknown", model: typeof req.body?.model === "string" ? req.body.model : undefined, status: res.statusCode, latencyMs: Date.now() - started }, true));
}
export function embeddingStats() { return JSON.parse(JSON.stringify(stats)) as Stats; }

export function recordEmbeddingData(body: { input?: unknown; model?: unknown }, raw: string, status: number, domain: string): void {
  let vectors: unknown = undefined;
  if (status >= 200 && status < 300) {
    try { vectors = (JSON.parse(raw) as { data?: Array<{ embedding?: unknown }> }).data?.map((item) => item.embedding); }
    catch { vectors = undefined; }
  }
  const event = { ts: new Date().toISOString(), domain, model: typeof body.model === "string" ? body.model : undefined, status, input: body.input, vectors };
  try { appendFileSync(config.embeddingDataFile, JSON.stringify(event) + "\n", { mode: 0o600 }); }
  catch (error) { console.error("[embeddings] data write failed:", error); }
}
