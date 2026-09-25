/**
 * Relay Pool — Codex (chatgpt.com backend) converter.
 *
 * Ported from anthropic-api-relay `lib/codexConverter.js` and the request-time
 * parts of `lib/codexAccount.js` (JWT decode + access token refresh).
 *
 * Endpoint: POST https://chatgpt.com/backend-api/codex/responses — the same API
 * the official Codex CLI uses (originator codex_cli_rs). Requests go through
 * the shared Firefox-TLS-fingerprint client (`services/chatgptTlsClient.ts`)
 * because Cloudflare challenges default Node TLS handshakes.
 */

import { createHash, randomUUID } from "node:crypto";
import { CODEX_CONFIG } from "@/lib/oauth/constants/oauth";
import { tlsFetchChatGpt } from "../../services/chatgptTlsClient.ts";

type JsonRecord = Record<string, unknown>;

// ─── Codex CLI identity ─────────────────────────────────────────────────────

const CODEX_CLIENT_VERSION = "0.144.1";
const CODEX_USER_AGENT = `codex-cli/${CODEX_CLIENT_VERSION} (Windows 10.0.26200; x64)`;

/**
 * Full Codex CLI header set for /backend-api/codex/responses.
 */
export function buildCodexRequestHeaders({
  accessToken,
  accountId,
}: {
  accessToken: string;
  accountId?: string | null;
}): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "User-Agent": CODEX_USER_AGENT,
    Version: CODEX_CLIENT_VERSION,
    // Identifies the client to the Codex backend — mirrors openai/codex
    // login/src/auth/default_client.rs DEFAULT_ORIGINATOR.
    originator: "codex_cli_rs",
    // Mandatory beta headers for Codex responses.
    "Openai-Beta": "responses=experimental",
    "X-Codex-Beta-Features": "responses_websockets",
    "Accept-Language": "en-US,en;q=0.9",
    ...(accountId ? { "chatgpt-account-id": accountId } : {}),
    // session_id — backend prompt-cache affinity; stable UUID per account.
    session_id: stableUuid(`codex-session:${accountId || accessToken.slice(0, 32) || "default"}`),
  };
}

function stableUuid(source: string): string {
  const h = createHash("sha256").update(String(source)).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// ─── JWT helpers ────────────────────────────────────────────────────────────

export function decodeJwtPayload(token: string): JsonRecord {
  const parts = String(token).split(".");
  if (parts.length !== 3) throw new Error("token is not a JWT");
  const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const json = Buffer.from(padded, "base64").toString("utf8");
  try {
    return JSON.parse(json);
  } catch {
    throw new Error("JWT payload is not valid JSON");
  }
}

export function looksLikeJwt(token: unknown): boolean {
  return typeof token === "string" && token.split(".").length === 3 && token.length > 40;
}

export function jwtExpired(token: string): boolean {
  try {
    const payload = decodeJwtPayload(token);
    if (typeof payload.exp === "number") return payload.exp * 1000 <= Date.now();
  } catch {}
  return false;
}

// ─── Access token resolution / refresh ──────────────────────────────────────

export async function refreshCodexAccessToken(
  refreshToken: string,
  options: { signal?: AbortSignal | null; proxyUrl?: string | null } = {}
): Promise<{ accessToken: string; refreshToken: string; expiresAt: string | null }> {
  const response = await tlsFetchChatGpt("https://auth.openai.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CODEX_CONFIG.clientId,
      scope: "openid profile email offline_access",
    }),
    signal: options.signal ?? null,
    timeoutMs: 30_000,
    proxyUrl: options.proxyUrl ?? undefined,
  });
  if (response.status !== 200) {
    throw new Error(
      `token refresh failed: HTTP ${response.status} ${(response.text || "").slice(0, 200)}`
    );
  }
  let data: JsonRecord;
  try {
    data = JSON.parse(response.text || "{}");
  } catch {
    throw new Error("token refresh response is not JSON");
  }
  if (!data.access_token || !looksLikeJwt(data.access_token)) {
    throw new Error("token refresh response did not contain access_token");
  }
  return {
    accessToken: data.access_token as string,
    refreshToken:
      typeof data.refresh_token === "string" && data.refresh_token
        ? data.refresh_token
        : refreshToken,
    expiresAt:
      typeof data.expires_in === "number"
        ? new Date(Date.now() + data.expires_in * 1000).toISOString()
        : null,
  };
}

export interface CodexAccountLike {
  apiKey?: string | null;
  codexRefreshToken?: string | null;
  proxyUrl?: string | null;
  model?: string | null;
}

/**
 * Resolve a usable JWT access token for a codex account.
 * Returns the stored token when present; otherwise attempts a refresh-token
 * round-trip. (The relay's cookie-blob exchange path is intentionally not
 * ported — accounts are provisioned with JWT or refresh tokens via the admin API.)
 */
export async function resolveCodexAccessToken(
  account: CodexAccountLike,
  options: { signal?: AbortSignal | null } = {}
): Promise<string> {
  const token = String(account.apiKey || "");
  if (token && looksLikeJwt(token)) return token;
  if (account.codexRefreshToken) {
    const refreshed = await refreshCodexAccessToken(account.codexRefreshToken, {
      signal: options.signal,
      proxyUrl: account.proxyUrl,
    });
    return refreshed.accessToken;
  }
  throw new Error("account has no usable codex credential (JWT or refresh token)");
}

// ─── OpenAI chat body → Codex Responses body ────────────────────────────────

function contentToText(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        const b = block as JsonRecord;
        if (b?.type === "text") return (b.text as string) || "";
        if (b?.type === "tool_use") {
          return `[tool call: ${b.name || "unknown"}(${JSON.stringify(b.input || {})})]`;
        }
        if (b?.type === "tool_result") {
          return `[tool result ${b.tool_use_id || ""}]: ${contentToText(b.content)}`;
        }
        if (b?.type === "image" || b?.type === "image_url") return "[image]";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof content === "object" && (content as JsonRecord).text) {
    return String((content as JsonRecord).text);
  }
  return "";
}

/**
 * OpenAI chat body → Codex Responses API body.
 * system/developer messages become `instructions`; the rest map to input
 * messages in order. Tool calls/results are flattened into readable text —
 * the Responses endpoint variant used here accepts text-only input.
 */
export function openAIToCodexResponses(
  body: unknown,
  { modelSlug }: { modelSlug?: string } = {}
): JsonRecord {
  const b = (body && typeof body === "object" ? body : {}) as JsonRecord;
  const messages = Array.isArray(b.messages) ? b.messages : [];

  let instructions = "";
  const input: JsonRecord[] = [];
  for (const raw of messages) {
    const m = (raw && typeof raw === "object" ? raw : {}) as JsonRecord;
    const role = String(m.role || "user");
    const text = contentToText(m.content ?? m);
    if (!text) continue;
    if (role === "system" || role === "developer") {
      instructions += (instructions ? "\n\n" : "") + text;
      continue;
    }
    input.push({
      type: "message",
      role: role === "assistant" ? "assistant" : "user",
      content: [{ type: role === "assistant" ? "output_text" : "input_text", text }],
    });
  }

  return {
    model: modelSlug || "gpt-5.5",
    ...(instructions ? { instructions } : {}),
    input,
    stream: true,
    store: false,
  };
}

// ─── Model slug selection ───────────────────────────────────────────────────

const normSlug = (s: unknown) =>
  String(s || "")
    .replace(/\./g, "-")
    .toLowerCase();

export function resolveCodexModelSlug(
  account: CodexAccountLike & { modelsCache?: string[] | null },
  requestedModel: string
): string {
  const cache = (Array.isArray(account.modelsCache) ? account.modelsCache : []).filter(Boolean);
  const want = String(requestedModel || account.model || "gpt-5.5").trim();
  if (!cache.length) return want;
  if (cache.includes(want)) return want;
  const nWant = normSlug(want);
  const hit =
    cache.find((id) => normSlug(id) === nWant) ||
    cache.find((id) => normSlug(id).startsWith(nWant)) ||
    cache.find((id) => nWant.startsWith(normSlug(id)));
  return hit || want;
}

// ─── SSE response parsing ───────────────────────────────────────────────────

export interface CodexSseResult {
  deltas: string[];
  answer: string;
  usage: { input_tokens: number; output_tokens: number } | null;
  error: string | null;
}

/**
 * Parse the full SSE text of /backend-api/codex/responses.
 * Events: response.output_text.delta → delta text; response.completed → usage;
 * response.failed / error → error message.
 */
export function parseCodexResponsesSSE(fullText: unknown): CodexSseResult {
  const deltas: string[] = [];
  let usage: CodexSseResult["usage"] = null;
  let error: string | null = null;

  for (const rawLine of String(fullText || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let event: JsonRecord;
    try {
      event = JSON.parse(payload);
    } catch {
      continue;
    }
    if (!event || typeof event !== "object") continue;

    const type = String(event.type || "");

    if (type === "response.output_text.delta" && typeof event.delta === "string") {
      deltas.push(event.delta);
    } else if (type === "response.completed" || type === "response.done") {
      const response = event.response as JsonRecord | undefined;
      const u = response?.usage as JsonRecord | undefined;
      if (u && typeof u === "object") {
        usage = {
          input_tokens: Number(u.input_tokens ?? u.prompt_tokens ?? 0),
          output_tokens: Number(u.output_tokens ?? u.completion_tokens ?? 0),
        };
      }
    } else if (type === "response.failed") {
      const response = event.response as JsonRecord | undefined;
      const err = response?.error as JsonRecord | undefined;
      error = (err?.message as string) || "response.failed";
    } else if (type === "error") {
      error =
        (event.message as string) ||
        ((event.error as JsonRecord | undefined)?.message as string) ||
        JSON.stringify(event).slice(0, 300);
    }
  }

  return { deltas, answer: deltas.join(""), usage, error };
}

// ─── Claude-format synthesis ────────────────────────────────────────────────

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Build a Claude-format SSE stream from parsed Codex deltas. Real usage when
 * available, length-based estimate otherwise. The relay synthesized OpenAI
 * SSE here; the omniroute port synthesizes Claude SSE directly because the
 * relay-pool provider's upstream format is claude.
 */
export function synthesizeAnthropicSSEFromCodex({
  model,
  deltas,
  usage = null,
  promptText = "",
}: {
  model: string;
  deltas: string[];
  usage?: { input_tokens: number; output_tokens: number } | null;
  promptText?: string;
}): string {
  const id = `msg_codex_${randomUUID().slice(0, 8)}`;
  const answer = deltas.join("");
  const inputTokens = usage?.input_tokens ?? Math.ceil(promptText.length / 4);
  const outputTokens = usage?.output_tokens ?? Math.ceil(answer.length / 4);

  let out = sseEvent("message_start", {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    },
  });
  out += sseEvent("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });
  for (const d of deltas) {
    if (!d) continue;
    out += sseEvent("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: d },
    });
  }
  out += sseEvent("content_block_stop", { type: "content_block_stop", index: 0 });
  out += sseEvent("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: outputTokens },
  });
  out += sseEvent("message_stop", { type: "message_stop" });
  return out;
}

/** Non-streaming Claude JSON built from parsed Codex deltas. */
export function synthesizeAnthropicJSONFromCodex({
  model,
  deltas,
  usage = null,
  promptText = "",
}: {
  model: string;
  deltas: string[];
  usage?: { input_tokens: number; output_tokens: number } | null;
  promptText?: string;
}): JsonRecord {
  const answer = deltas.join("");
  const inputTokens = usage?.input_tokens ?? Math.ceil(promptText.length / 4);
  const outputTokens = usage?.output_tokens ?? Math.ceil(answer.length / 4);
  return {
    id: `msg_codex_${randomUUID().slice(0, 8)}`,
    type: "message",
    role: "assistant",
    model,
    content: answer ? [{ type: "text", text: answer }] : [],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}
