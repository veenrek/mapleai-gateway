/**
 * RelayPoolExecutor — upstream account rotation pool.
 *
 * Ported from anthropic-api-relay `server.js` (fetchWithAccounts / tryAccount /
 * tryCodexAccount / relayToUpstream wait-loop). The provider receives
 * Claude-format bodies (chatCore translates client requests before dispatch)
 * and rotates through `relay_accounts` rows:
 *
 *   Phase 1  anthropic-sticky  — the last successful anthropic account (if any)
 *   Phase 2  anthropic         — all anthropic accounts, per-model round-robin,
 *                                optionally raced in parallel (PARALLEL_ANTHROPIC)
 *   Phase 3  openai-fallback   — top MAX_OPENAI_FALLBACK_ACCOUNTS openai
 *                                accounts via the anthropic→openai converter
 *   Phase 4  codex-fallback    — codex (chatgpt.com backend) accounts via the
 *                                anthropic→openai→codex converter chain
 *   Phase 5  cooldown-override — ALL family accounts force-tried with
 *                                cooldowns cleared (2 passes, 10s pause)
 *
 * Account-related errors (429/401/403/529/quota/model_not_found) rotate to the
 * next account; client errors (400 invalid request etc.) return immediately.
 * When the retry budget is exhausted a synthetic Claude stop message is
 * returned instead of hanging the client.
 */

import { BaseExecutor, mergeAbortSignals, type ExecuteInput, type ExecutorLog } from "./base.ts";
import { createProxyDispatcher, getDefaultDispatcher } from "../utils/proxyDispatcher.ts";
import {
  anthropicToOpenAI,
  openAIToAnthropicResponse,
  openAIStreamAsAnthropicResponse,
  type StreamUsage,
} from "./relayPool/anthropicOpenAI.ts";
import {
  buildCodexRequestHeaders,
  openAIToCodexResponses,
  resolveCodexAccessToken,
  resolveCodexModelSlug,
  parseCodexResponsesSSE,
  synthesizeAnthropicSSEFromCodex,
  synthesizeAnthropicJSONFromCodex,
} from "./relayPool/codexConverter.ts";
import { tlsFetchChatGpt } from "../services/chatgptTlsClient.ts";
import {
  getEnabledRelayAccounts,
  markRelayAccountSuccess,
  markRelayAccountError,
  addRelayTokenUsage,
  setRelayAccountActive,
  type RelayAccount,
} from "@/lib/db/relayAccounts";

type JsonRecord = Record<string, unknown>;

// ─── Tunables (env) ─────────────────────────────────────────────────────────

const envNum = (name: string, dflt: number) => {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) ? raw : dflt;
};

const UPSTREAM_TIMEOUT_MS = envNum("UPSTREAM_TIMEOUT_MS", 60_000);
const OPENAI_UPSTREAM_TIMEOUT_MS = envNum("OPENAI_UPSTREAM_TIMEOUT_MS", 30_000);
const UPSTREAM_RETRIES = envNum("UPSTREAM_RETRIES", 0);
const UPSTREAM_RETRY_DELAY_MS = envNum("UPSTREAM_RETRY_DELAY_MS", 750);
const MAX_OPENAI_FALLBACK_ACCOUNTS = envNum("MAX_OPENAI_FALLBACK_ACCOUNTS", 3);
const MAX_ACCOUNTS_PER_REQUEST = envNum("MAX_ACCOUNTS_PER_REQUEST", 3);
const PARALLEL_ANTHROPIC = process.env.PARALLEL_ANTHROPIC !== "0";
const STICKY_ANTHROPIC = process.env.STICKY_ANTHROPIC !== "0";
const ROUND_ROBIN_PER_MODEL = process.env.ROUND_ROBIN_PER_MODEL !== "0";
const RECENT_ERROR_TTL_MS = envNum("RECENT_ERROR_TTL_MS", 30_000);
const FETCH_PHASE_DEADLINE_MS = envNum("FETCH_PHASE_DEADLINE_MS", 60_000);
const API_ERROR_RETRY_BUDGET = envNum("API_ERROR_RETRY_BUDGET", 3);
const RELAY_WAIT_FOR_ACCOUNT_MS = envNum("RELAY_WAIT_FOR_ACCOUNT_MS", 180_000);
const RELAY_WAIT_POLL_MS = envNum("RELAY_WAIT_POLL_MS", 3_000);
const RELAY_CAPACITY_RETRY_MS = envNum("RELAY_CAPACITY_RETRY_MS", 20_000);
const RELAY_CAPACITY_POLL_MS = envNum("RELAY_CAPACITY_POLL_MS", 3_000);

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "content-encoding",
]);

// ─── Rotation state (in-memory, per process) ────────────────────────────────

const modelRoundRobin = new Map<string, number>(); // model group -> counter
const accountRecentErrors = new Map<string, number>(); // accountId -> expiresAt

function isAccountBlocked(account: RelayAccount): boolean {
  if (account.cooldownUntil && Date.parse(account.cooldownUntil) > Date.now()) return true;
  if (account.disabledUntil && Date.parse(account.disabledUntil) > Date.now()) return true;
  if (!account.enabled) return true;
  const recentErrorUntil = accountRecentErrors.get(account.id);
  if (recentErrorUntil && recentErrorUntil > Date.now()) return true;
  return false;
}

function markAccountRecentError(accountId: string): void {
  accountRecentErrors.set(accountId, Date.now() + RECENT_ERROR_TTL_MS);
}

function accountSortScore(account: RelayAccount): number {
  let score = 0;
  const lastError = String(account.lastError || "");
  if (account.active) score -= 10_000;
  if (/aborted|abort|terminated|fetch failed|proxy/i.test(lastError)) score += 5_000;
  if (/limit|insufficient balance|top up|quota/i.test(lastError)) score += 2_000;
  score -= account.successCount * 20;
  score += account.errorCount * 5;
  return score;
}

function sortCandidateAccounts(accounts: RelayAccount[]): RelayAccount[] {
  return [...accounts].sort((a, b) => {
    const aBlocked = isAccountBlocked(a) ? 1 : 0;
    const bBlocked = isAccountBlocked(b) ? 1 : 0;
    if (aBlocked !== bBlocked) return aBlocked - bBlocked;
    return accountSortScore(a) - accountSortScore(b);
  });
}

/**
 * Round-robin reorder within groups of accounts sharing the same
 * `account.model`. Counters move only among unblocked accounts so a mass
 * cooldown cannot trap rotation on broken upstreams.
 */
function reorderRoundRobin(accounts: RelayAccount[]): RelayAccount[] {
  if (accounts.length <= 1 || !ROUND_ROBIN_PER_MODEL) return accounts;
  let healthy = accounts.filter((a) => !isAccountBlocked(a));
  if (!healthy.length) {
    for (const a of accounts) accountRecentErrors.delete(a.id);
    healthy = accounts;
  }
  const grouped = new Map<string, RelayAccount[]>();
  for (const account of accounts) {
    const key = String(account.model || "").trim() || "__any__";
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(account);
  }
  const reordered: RelayAccount[] = [];
  for (const group of grouped.values()) {
    const pool = group.filter((a) => !isAccountBlocked(a));
    const key = String(pool[0]?.model || group[0].model || "");
    const next = (modelRoundRobin.get(key) || 0) + 1;
    modelRoundRobin.set(key, next);
    const start = group.length > 1 ? (next - 1) % group.length : 0;
    for (let i = 0; i < group.length; i += 1) {
      reordered.push(group[(start + i) % group.length]);
    }
  }
  return reordered;
}

// ─── Error classification (ported from lib/accountRotation.js) ──────────────

export function isAccountRelatedError(status: number, bodyText = ""): boolean {
  if ([401, 402, 403, 404, 429, 502, 529].includes(status)) return true;
  if (
    /weekly rate limit|top up balance|insufficient balance|quota|credits|concurrency limit|too many concurrent|all accounts busy/i.test(
      bodyText
    )
  ) {
    return true;
  }
  if (
    status === 503 &&
    /No available accounts|quota|rate.?limit|credits|account|Service Unavailable|overloaded|busy|concurrency/i.test(
      bodyText
    )
  ) {
    return true;
  }
  // model_not_found / model_not_exists: the model is unknown to this specific
  // upstream account — rotate to the next account instead of failing the client.
  if (
    /model_not_found|model_not_exists|The model .* does not exist|model .* not found|model .* not supported|unknown model|模型不存在/i.test(
      bodyText
    )
  ) {
    return true;
  }
  return false;
}

/** Strict cooldown policy: only 429 cools down, and always exactly 5 seconds. */
export function cooldownForStatus(status: number, bodyText = ""): number {
  if (status === 429 || /Too Many Requests|rate.?limit exceeded/i.test(bodyText)) return 5_000;
  return 0;
}

function isAbortLikeError(error: unknown): boolean {
  const err = error as { name?: string; message?: string } | undefined;
  const text = String(err?.message || error || "");
  return (
    err?.name === "AbortError" ||
    /aborted|abort|terminated|other side closed|UND_ERR_SOCKET/i.test(text)
  );
}

function shouldRetryUpstream(status: number, bodyText = ""): boolean {
  if (/No available (OAuth )?accounts|no available accounts/i.test(bodyText)) return false;
  if (/No provider capacity/i.test(bodyText)) return false;
  if ([429, 502, 504].includes(status)) return true;
  if (status === 503) return false;
  return /Service Unavailable|upstream chain/i.test(bodyText);
}

// ─── URL helpers ────────────────────────────────────────────────────────────

function resolveAccountBaseUrl(account: RelayAccount): string {
  if (account.baseUrl) return account.baseUrl.replace(/\/$/, "");
  if (account.providerType === "openai") {
    return (process.env.OPENAI_BASE_URL || "https://api.openai.com").replace(/\/$/, "");
  }
  if (account.providerType === "codex") return "https://chatgpt.com/backend-api/codex/responses";
  return (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/$/, "");
}

export { resolveAccountBaseUrl };

function applyAuthHeader(headers: Record<string, string>, account: RelayAccount): void {
  const key = account.apiKey || "";
  if (account.authHeader === "authorization") {
    headers["Authorization"] = `Bearer ${key}`;
  } else {
    headers[account.authHeader || "x-api-key"] = key;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Synthetic Claude stop message ──────────────────────────────────────────

function syntheticClaudeResponse(
  model: string,
  text: string,
  stream: boolean,
  status = 200
): Response {
  const id = `msg_relay_${Date.now()}`;
  if (stream) {
    const body =
      `event: message_start\ndata: ${JSON.stringify({
        type: "message_start",
        message: {
          id,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      })}\n\n` +
      `event: content_block_start\ndata: ${JSON.stringify({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      })}\n\n` +
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      })}\n\n` +
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n` +
      `event: message_delta\ndata: ${JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 0 },
      })}\n\n` +
      `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`;
    return new Response(body, {
      status,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    });
  }
  return new Response(
    JSON.stringify({
      id,
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    }),
    { status, headers: { "content-type": "application/json" } }
  );
}

// ─── Executor ───────────────────────────────────────────────────────────────

interface TryOutcome {
  type: "success" | "fail" | "return" | "cancelled";
  result?: {
    response: Response;
    url: string;
    headers: Record<string, string>;
    transformedBody?: JsonRecord;
  };
  failure?: { account: string; status: number; error: string };
  lastResult?: { response: Response; errorText: string };
}

export class RelayPoolExecutor extends BaseExecutor {
  constructor(provider = "relay-pool") {
    super(provider, { id: provider, format: "claude" });
  }

  buildUrl(): string {
    // Only used for count_tokens probing; the real per-request URL is chosen
    // per account inside execute().
    const accounts = getEnabledRelayAccounts();
    const anthropic = accounts.find((a) => a.providerType === "anthropic");
    if (!anthropic) return "";
    return `${resolveAccountBaseUrl(anthropic)}/v1/messages`;
  }

  async execute(input: ExecuteInput) {
    const { body, stream, signal, log, model } = input;
    const requestedModel = model || String((body as JsonRecord)?.model || "");

    let waitDeadline = Date.now() + RELAY_WAIT_FOR_ACCOUNT_MS;
    let capacityDeadline = 0;
    let retryBudgetUsed = 0;

    // Hold-and-retry loop: exhausted/capacity/5xx outcomes hold the request and
    // re-rotate instead of failing the client immediately (ported from the
    // relayToUpstream wait-loop).
    while (true) {
      const accountResult = await this.fetchWithAccounts(body, stream, requestedModel, signal, log);
      const status = accountResult.response.status;
      const text = String(accountResult.errorText || "");
      const capacityError = /No provider capacity/i.test(text);
      const exhausted = /All relay accounts are exhausted|No usable relay accounts available/i.test(
        text
      );
      const retryable = status >= 500;

      if (capacityError && !capacityDeadline)
        capacityDeadline = Date.now() + RELAY_CAPACITY_RETRY_MS;
      const deadline = Math.max(waitDeadline, capacityDeadline);

      if ((exhausted || retryable) && signal?.aborted !== true && Date.now() < deadline) {
        if (capacityError) {
          log?.info?.(
            "RELAY_POOL",
            `provider overloaded (capacity); retrying in ${RELAY_CAPACITY_POLL_MS}ms`
          );
          await sleep(RELAY_CAPACITY_POLL_MS);
          continue;
        }
        retryBudgetUsed += 1;
        if (retryBudgetUsed >= API_ERROR_RETRY_BUDGET) {
          log?.warn?.(
            "RELAY_POOL",
            `retry budget exhausted (${retryBudgetUsed}/${API_ERROR_RETRY_BUDGET}); returning synthetic stop`
          );
          const response = syntheticClaudeResponse(
            requestedModel,
            `Relay stopped after ${retryBudgetUsed} retryable upstream errors. No usable upstream accounts are responding. Check the relay pool in /dashboard/relay or try again later.`,
            stream
          );
          return {
            response,
            url: "relay-pool://synthetic-stop",
            headers: {},
            transformedBody: null,
          };
        }
        log?.info?.(
          "RELAY_POOL",
          `upstream unavailable; holding request ${RELAY_WAIT_POLL_MS}ms instead of failing (attempt ${retryBudgetUsed}/${API_ERROR_RETRY_BUDGET})`
        );
        await sleep(RELAY_WAIT_POLL_MS);
        continue;
      }

      const { response, url, headers } = accountResult.result ?? {
        response: accountResult.response,
        url: "relay-pool://upstream",
        headers: {} as Record<string, string>,
      };

      // Capacity window expired: return a clear message instead of a bare 503.
      if (capacityError) {
        const synthetic = syntheticClaudeResponse(
          requestedModel,
          `Relay waited ${Math.round(RELAY_CAPACITY_RETRY_MS / 1000)}s for upstream provider capacity, but it is still overloaded. Try again in a few seconds.`,
          stream
        );
        return {
          response: synthetic,
          url: "relay-pool://capacity-stop",
          headers: {},
          transformedBody: null,
        };
      }

      return { response, url, headers, transformedBody: null };
    }
  }

  private async fetchWithAccounts(
    originalBody: unknown,
    stream: boolean,
    requestedModel: string,
    signal: AbortSignal | null | undefined,
    log: ExecutorLog | null
  ): Promise<{
    response: Response;
    errorText: string;
    result?: { response: Response; url: string; headers: Record<string, string> };
  }> {
    const allConfiguredAccounts = getEnabledRelayAccounts().filter(
      (a) =>
        // Mirror the standalone relay's isAccountAvailable(): an account without
        // usable credentials is never a candidate.
        Boolean(a.apiKey) || (a.providerType === "codex" && Boolean(a.codexRefreshToken))
    );
    const anthropicAccounts = sortCandidateAccounts(
      allConfiguredAccounts.filter((a) => a.providerType === "anthropic")
    );
    const openaiAccounts = sortCandidateAccounts(
      allConfiguredAccounts.filter((a) => a.providerType === "openai")
    );
    const codexAccounts = sortCandidateAccounts(
      allConfiguredAccounts.filter((a) => a.providerType === "codex")
    );

    const converterAccounts = [
      ...openaiAccounts.slice(0, MAX_OPENAI_FALLBACK_ACCOUNTS || openaiAccounts.length),
      ...codexAccounts,
    ];
    let matchingAnthropic = anthropicAccounts;
    if (converterAccounts.length && MAX_ACCOUNTS_PER_REQUEST > 0) {
      matchingAnthropic = anthropicAccounts.slice(0, MAX_ACCOUNTS_PER_REQUEST);
    }

    interface Phase {
      name: string;
      accounts: RelayAccount[];
      kind: "anthropic" | "openai" | "codex";
    }

    const candidatePhases: Phase[] = [];

    if (matchingAnthropic.length) {
      const sticky = STICKY_ANTHROPIC ? matchingAnthropic.find((a) => a.active) : null;
      if (sticky) {
        candidatePhases.push({ name: "anthropic-sticky", accounts: [sticky], kind: "anthropic" });
        const rest = matchingAnthropic.filter((a) => a.id !== sticky.id);
        if (rest.length) {
          candidatePhases.push({
            name: "anthropic",
            accounts: reorderRoundRobin(rest),
            kind: "anthropic",
          });
        }
      } else {
        candidatePhases.push({
          name: "anthropic",
          accounts: reorderRoundRobin(matchingAnthropic),
          kind: "anthropic",
        });
      }
    }
    if (openaiAccounts.length) {
      candidatePhases.push({
        name: "openai-fallback",
        accounts: openaiAccounts.slice(0, MAX_OPENAI_FALLBACK_ACCOUNTS || openaiAccounts.length),
        kind: "openai",
      });
    }
    if (codexAccounts.length) {
      candidatePhases.push({ name: "codex-fallback", accounts: codexAccounts, kind: "codex" });
    }

    // No candidates at all → force-try every enabled account with cooldowns
    // cleared (override on request only; DB state untouched).
    if (!candidatePhases.length && allConfiguredAccounts.length) {
      const forced = allConfiguredAccounts.map((a) => ({
        ...a,
        cooldownUntil: null,
        disabledUntil: null,
      }));
      candidatePhases.push({
        name: "cooldown-override",
        accounts: sortCandidateAccounts(forced),
        kind: "anthropic",
      });
      log?.info?.(
        "RELAY_POOL",
        `no available accounts; forcing ${forced.length} blocked account(s) as override`
      );
    }

    if (!candidatePhases.length) {
      const response = new Response(
        JSON.stringify({
          error: {
            type: "service_unavailable",
            message:
              "All relay accounts are exhausted. Configure upstream accounts in /dashboard/relay.",
          },
        }),
        { status: 503, headers: { "content-type": "application/json" } }
      );
      return { response, errorText: "All relay accounts are exhausted" };
    }

    let lastResult: { response: Response; errorText: string } | undefined;
    const failures: Array<{ account: string; status: number; error: string }> = [];

    for (const phase of candidatePhases) {
      const phaseController = new AbortController();
      const phaseTimer = setTimeout(() => phaseController.abort(), FETCH_PHASE_DEADLINE_MS);
      const onAbort = () => phaseController.abort();
      signal?.addEventListener("abort", onAbort, { once: true });

      try {
        const isOverridePhase = /cooldown-override/.test(phase.name);
        const overridePasses = isOverridePhase ? 2 : 1;
        let consecutiveFailures = 0;

        for (let pass = 0; pass < overridePasses; pass += 1) {
          if (phaseController.signal.aborted) break;

          if (
            PARALLEL_ANTHROPIC &&
            phase.kind === "anthropic" &&
            phase.accounts.length > 1 &&
            !isOverridePhase
          ) {
            // Race all anthropic accounts concurrently; first success wins.
            const outcome = await this.raceAnthropicPhase(
              phase.accounts,
              originalBody,
              stream,
              requestedModel,
              phaseController.signal,
              log
            );
            if (outcome.failure) failures.push(outcome.failure);
            if (outcome.lastResult) lastResult = outcome.lastResult;
            if (outcome.type === "success" || outcome.type === "return") return outcome as never;
            break;
          }

          for (const account of phase.accounts) {
            if (phaseController.signal.aborted) break;
            const outcome = await this.tryAccount(
              account,
              phase.kind,
              phase.name,
              originalBody,
              stream,
              requestedModel,
              phaseController.signal,
              log
            );
            if (outcome.failure) failures.push(outcome.failure);
            if (outcome.lastResult) lastResult = outcome.lastResult;
            if (outcome.type === "success" || outcome.type === "return") {
              return this.normalizeOutcome(outcome);
            }
            consecutiveFailures += 1;
            // First account-related failure in a healthy phase → jump straight
            // to the override phase instead of walking every timeout.
            if (!isOverridePhase && consecutiveFailures >= 1) break;
          }
          if (isOverridePhase && pass < overridePasses - 1 && !phaseController.signal.aborted) {
            await sleep(10_000);
            for (const a of phase.accounts) accountRecentErrors.delete(a.id);
          }
          if (!isOverridePhase && consecutiveFailures >= 1) break;
        }
      } finally {
        clearTimeout(phaseTimer);
        signal?.removeEventListener("abort", onAbort);
      }
    }

    // All standard phases failed → last-resort override (if not already tried).
    const lastStatus = lastResult?.response.status;
    const shouldTriggerOverride = !lastResult || (lastStatus !== undefined && lastStatus >= 400);
    if (shouldTriggerOverride && !candidatePhases.some((p) => /cooldown-override/.test(p.name))) {
      const forced = allConfiguredAccounts
        .filter((a) => a.apiKey)
        .map((a) => ({ ...a, cooldownUntil: null, disabledUntil: null }));
      if (forced.length) {
        log?.info?.(
          "RELAY_POOL",
          `all phases failed; forcing ${forced.length} account(s) as last resort`
        );
        const overridePhase: Phase = {
          name: "cooldown-override",
          accounts: sortCandidateAccounts(forced),
          kind: "anthropic",
        };
        const phaseController = new AbortController();
        const phaseTimer = setTimeout(() => phaseController.abort(), FETCH_PHASE_DEADLINE_MS * 2);
        try {
          for (let pass = 0; pass < 2; pass += 1) {
            if (phaseController.signal.aborted) break;
            for (const account of overridePhase.accounts) {
              if (phaseController.signal.aborted) break;
              const outcome = await this.tryAccount(
                account,
                account.providerType,
                overridePhase.name,
                originalBody,
                stream,
                requestedModel,
                phaseController.signal,
                log
              );
              if (outcome.failure) failures.push(outcome.failure);
              if (outcome.lastResult) lastResult = outcome.lastResult;
              if (outcome.type === "success" || outcome.type === "return")
                return this.normalizeOutcome(outcome);
            }
            if (pass < 1 && !phaseController.signal.aborted) {
              await sleep(10_000);
              for (const a of overridePhase.accounts) accountRecentErrors.delete(a.id);
            }
          }
        } finally {
          clearTimeout(phaseTimer);
        }
      }
    }

    if (failures.length || lastResult) {
      const response = new Response(
        JSON.stringify({
          error: {
            type: "service_unavailable",
            message: "No usable relay accounts available.",
            failures: failures.slice(0, 10),
          },
        }),
        { status: 503, headers: { "content-type": "application/json" } }
      );
      return {
        response,
        errorText: JSON.stringify({ error: "No usable relay accounts available", failures }),
      };
    }

    const response = new Response(
      JSON.stringify({
        error: { type: "service_unavailable", message: "No usable relay accounts available." },
      }),
      { status: 503, headers: { "content-type": "application/json" } }
    );
    return { response, errorText: "No usable relay accounts available" };
  }

  /** Normalize a terminal TryOutcome into the fetchWithAccounts return shape. */
  private normalizeOutcome(outcome: TryOutcome): {
    response: Response;
    errorText: string;
    result?: { response: Response; url: string; headers: Record<string, string> };
  } {
    if (outcome.result) {
      return {
        response: outcome.result.response,
        errorText: outcome.result.response.status >= 400 ? "upstream client error" : "",
        result: outcome.result,
      };
    }
    return (
      outcome.lastResult ?? {
        response: new Response(
          JSON.stringify({
            error: { type: "service_unavailable", message: "No usable relay accounts available." },
          }),
          { status: 503, headers: { "content-type": "application/json" } }
        ),
        errorText: "No usable relay accounts available",
      }
    );
  }

  private async raceAnthropicPhase(
    accounts: RelayAccount[],
    originalBody: unknown,
    stream: boolean,
    requestedModel: string,
    signal: AbortSignal,
    log: ExecutorLog | null
  ): Promise<TryOutcome> {
    const wrapped = accounts.map((account, index) =>
      this.tryAccount(
        account,
        "anthropic",
        "anthropic-parallel",
        originalBody,
        stream,
        requestedModel,
        signal,
        log
      ).then((outcome) => ({ index, outcome }))
    );
    const pending = new Map(wrapped.map((promise, index) => [index, promise]));
    let lastOutcome: TryOutcome | undefined;
    try {
      while (pending.size) {
        if (signal.aborted) break;
        const settled = await Promise.race(pending.values());
        pending.delete(settled.index);
        lastOutcome = settled.outcome;
        if (settled.outcome.failure) return settled.outcome; // caller aggregates below
        if (settled.outcome.type === "success" || settled.outcome.type === "return") {
          return settled.outcome;
        }
      }
    } catch {
      // fall through to last outcome
    }
    return (
      lastOutcome ?? {
        type: "fail",
        failure: { account: "*", status: 503, error: "parallel race produced no outcome" },
      }
    );
  }

  private async tryAccount(
    account: RelayAccount,
    kind: "anthropic" | "openai" | "codex",
    phaseName: string,
    originalBody: unknown,
    stream: boolean,
    requestedModel: string,
    signal: AbortSignal | null,
    log: ExecutorLog | null
  ): Promise<TryOutcome> {
    const startedAt = Date.now();
    const fail = (status: number, message: string): TryOutcome => ({
      type: "fail",
      failure: { account: account.name, status, error: message.slice(0, 300) },
      lastResult: {
        response: new Response(message, { status }),
        errorText: message,
      },
    });

    try {
      if (kind === "codex") {
        return await this.tryCodexAccount(
          account,
          phaseName,
          originalBody,
          stream,
          requestedModel,
          signal,
          log,
          startedAt
        );
      }

      const usingConverter = kind === "openai";
      const convertedBody = usingConverter
        ? anthropicToOpenAI(originalBody, account)
        : originalBody;
      if (usingConverter) (convertedBody as JsonRecord).stream = Boolean(stream);

      const baseUrl = resolveAccountBaseUrl(account);
      const url = usingConverter ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/messages`;

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: stream ? "text/event-stream" : "application/json",
      };
      if (usingConverter) {
        headers["Authorization"] = `Bearer ${account.apiKey || ""}`;
      } else {
        applyAuthHeader(headers, account);
        headers["anthropic-version"] = process.env.ANTHROPIC_VERSION || "2023-06-01";
      }

      const dispatcher = account.proxyUrl
        ? createProxyDispatcher(account.proxyUrl)
        : getDefaultDispatcher();

      const timeoutMs = usingConverter ? OPENAI_UPSTREAM_TIMEOUT_MS : UPSTREAM_TIMEOUT_MS;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const mergedSignal = signal
        ? mergeAbortSignals(signal, controller.signal)
        : controller.signal;

      let response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(convertedBody),
        dispatcher,
        signal: mergedSignal,
      } as RequestInit);

      let errorBodyText = "";
      if (response.status >= 400) {
        errorBodyText = await response.text().catch(() => "");
        // Short intra-account retry for transient upstream failures (429/502/504).
        for (
          let attempt = 0;
          UPSTREAM_RETRIES > 0 &&
          attempt < UPSTREAM_RETRIES &&
          response.status >= 400 &&
          shouldRetryUpstream(response.status, errorBodyText);
          attempt += 1
        ) {
          await sleep(UPSTREAM_RETRY_DELAY_MS * (attempt + 1));
          response = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify(convertedBody),
            dispatcher,
            signal: mergedSignal,
          } as RequestInit);
          if (response.status >= 400) {
            errorBodyText = await response.text().catch(() => "");
          }
        }

        if (response.status >= 400) {
          if (isAccountRelatedError(response.status, errorBodyText)) {
            const cooldownMs = /No provider capacity/i.test(errorBodyText)
              ? 0
              : cooldownForStatus(response.status, errorBodyText);
            await markRelayAccountError(account.id, response.status, errorBodyText, cooldownMs);
            markAccountRecentError(account.id);
            log?.info?.(
              "RELAY_POOL",
              `rotate from ${account.name} after ${Date.now() - startedAt}ms: HTTP ${response.status}`
            );
            return fail(response.status, errorBodyText || `HTTP ${response.status}`);
          }
          // Client error (bad request etc.) — surface immediately.
          return {
            type: "return",
            lastResult: { response, errorText: errorBodyText },
            result: {
              response: new Response(errorBodyText || "Upstream request failed", {
                status: response.status,
                headers: {
                  "content-type": response.headers.get("content-type") || "application/json",
                },
              }),
              url,
              headers,
            },
          };
        }
      }

      // Success path — convert response to Claude format when needed.
      const usage = await this.recordSuccess(
        account,
        response,
        usingConverter,
        stream,
        requestedModel
      );
      void usage;
      log?.info?.(
        "RELAY_POOL",
        `success ${account.name} (${phaseName}) after ${Date.now() - startedAt}ms`
      );

      let finalResponse = response;
      if (usingConverter) {
        if (stream) {
          finalResponse = openAIStreamAsAnthropicResponse(
            response,
            requestedModel || account.model || "openai",
            (u) => {
              void addRelayTokenUsage(account.id, u.input_tokens, u.output_tokens);
            }
          );
        } else {
          const data = (await response.json().catch(() => ({}))) as JsonRecord;
          const u = (data.usage ?? {}) as JsonRecord;
          const inTok = Number(u.prompt_tokens || 0);
          const outTok = Number(u.completion_tokens || 0);
          if (inTok || outTok) void addRelayTokenUsage(account.id, inTok, outTok);
          finalResponse = new Response(
            JSON.stringify(
              openAIToAnthropicResponse(
                data,
                requestedModel || account.model || (data.model as string)
              )
            ),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
      }

      return {
        type: "success",
        result: { response: finalResponse, url, headers },
      };
    } catch (error) {
      if (signal?.aborted) return { type: "cancelled" };
      const message = String((error as Error)?.message || error || "fetch failed");
      // Transient aborts/zero cooldown; real failures get the 429-only policy.
      const fetchCooldownMs = /aborted|abort|terminated|This operation was aborted/i.test(message)
        ? 0
        : cooldownForStatus(502, message);
      await markRelayAccountError(account.id, 502, message, fetchCooldownMs);
      if (!/aborted|abort|terminated|fetch failed/i.test(message)) {
        markAccountRecentError(account.id);
      }
      log?.warn?.(
        "RELAY_POOL",
        `rotate from ${account.name} after ${Date.now() - startedAt}ms fetch error: ${message}`
      );
      return fail(502, message);
    }
  }

  private async tryCodexAccount(
    account: RelayAccount,
    phaseName: string,
    originalBody: unknown,
    stream: boolean,
    requestedModel: string,
    signal: AbortSignal | null,
    log: ExecutorLog | null,
    startedAt: number
  ): Promise<TryOutcome> {
    const fail = (status: number, message: string): TryOutcome => ({
      type: "fail",
      failure: { account: account.name, status, error: message.slice(0, 300) },
      lastResult: { response: new Response(message, { status }), errorText: message },
    });

    let accessToken: string;
    try {
      accessToken = await resolveCodexAccessToken(account, { signal });
    } catch (error) {
      const message = `codex auth failed: ${String((error as Error)?.message || error)}`;
      await markRelayAccountError(account.id, 401, message, cooldownForStatus(401, message));
      return fail(401, message);
    }

    const slug = resolveCodexModelSlug(account, requestedModel);
    const openaiBody = anthropicToOpenAI(originalBody, account);
    const convBody = openAIToCodexResponses(openaiBody, { modelSlug: slug });
    const promptText = ((convBody.input as JsonRecord[]) || [])
      .map((m) => {
        const content = m.content as JsonRecord[] | undefined;
        return content?.[0]?.text || "";
      })
      .join("\n");

    const postToCodex = async (token: string) => {
      const headers = buildCodexRequestHeaders({
        accessToken: token,
        accountId: account.codexAccountId || null,
      });
      try {
        const resp = await tlsFetchChatGpt(resolveAccountBaseUrl(account), {
          method: "POST",
          headers,
          body: JSON.stringify(convBody),
          proxyUrl: account.proxyUrl || undefined,
          timeoutMs: OPENAI_UPSTREAM_TIMEOUT_MS,
          signal,
        });
        if (resp.status >= 400) {
          return { errorStatus: resp.status, errorText: String(resp.text || "").slice(0, 500) };
        }
        return { resp };
      } catch (error) {
        if (signal?.aborted) return { cancelled: true as const };
        return {
          errorStatus: 502,
          errorText: `codex fetch failed: ${String((error as Error)?.message || error)}`,
        };
      }
    };

    let attempt = await postToCodex(accessToken);
    if ("cancelled" in attempt) return { type: "cancelled" };

    // 401 → refresh → retry once.
    if ("errorStatus" in attempt && attempt.errorStatus === 401 && account.codexRefreshToken) {
      log?.info?.("RELAY_POOL", `${account.name} got 401, refreshing codex access token`);
      try {
        const { refreshCodexAccessToken } = await import("./relayPool/codexConverter.ts");
        const refreshed = await refreshCodexAccessToken(account.codexRefreshToken, {
          signal,
          proxyUrl: account.proxyUrl,
        });
        accessToken = refreshed.accessToken;
        const { updateRelayAccount } = await import("@/lib/db/relayAccounts");
        void updateRelayAccount(account.id, {
          codexRefreshToken: refreshed.refreshToken,
          codexExpiresAt: refreshed.expiresAt,
        });
        account.apiKey = refreshed.accessToken;
        attempt = await postToCodex(accessToken);
        if ("cancelled" in attempt) return { type: "cancelled" };
      } catch (error) {
        const message = `codex refresh failed: ${String((error as Error)?.message || error)}`;
        await markRelayAccountError(account.id, 401, message, cooldownForStatus(401, message));
        return fail(401, message);
      }
    }

    if ("errorStatus" in attempt) {
      const status = attempt.errorStatus;
      const text = attempt.errorText;
      await markRelayAccountError(account.id, status, text, cooldownForStatus(status, text));
      log?.info?.(
        "RELAY_POOL",
        `rotate from ${account.name} after ${Date.now() - startedAt}ms: HTTP ${status} ${text.slice(0, 140)}`
      );
      return fail(status, text || `HTTP ${status}`);
    }

    const { deltas, usage, error: streamError } = parseCodexResponsesSSE(attempt.resp!.text);
    if (streamError && !deltas.length) {
      const message = `codex stream error: ${streamError}`;
      await markRelayAccountError(account.id, 502, message, cooldownForStatus(502, message));
      return fail(502, message);
    }

    await markRelayAccountSuccess(account.id, {
      tokensIn: usage?.input_tokens ?? Math.ceil(promptText.length / 4),
      tokensOut: usage?.output_tokens ?? Math.ceil(deltas.join("").length / 4),
    });
    log?.info?.(
      "RELAY_POOL",
      `success ${account.name} (${phaseName}, slug=${slug}) after ${Date.now() - startedAt}ms, ${deltas.join("").length} chars`
    );

    const modelOut = requestedModel || slug;
    const sseBody = synthesizeAnthropicSSEFromCodex({ model: modelOut, deltas, usage, promptText });
    const response = stream
      ? new Response(sseBody, {
          status: 200,
          headers: { "content-type": "text/event-stream; charset=utf-8" },
        })
      : new Response(
          JSON.stringify(
            synthesizeAnthropicJSONFromCodex({ model: modelOut, deltas, usage, promptText })
          ),
          { status: 200, headers: { "content-type": "application/json" } }
        );
    return {
      type: "success",
      result: { response, url: resolveAccountBaseUrl(account), headers: {} },
    };
  }

  /** Extract usage from an anthropic-format response and record success. */
  private async recordSuccess(
    account: RelayAccount,
    response: Response,
    usingConverter: boolean,
    stream: boolean,
    requestedModel: string
  ): Promise<StreamUsage | null> {
    accountRecentErrors.delete(account.id);
    if (usingConverter) return null; // usage recorded by the converter path

    if (!stream) {
      try {
        const cloned = response.clone();
        const data = (await cloned.json()) as JsonRecord;
        const u = (data.usage ?? {}) as JsonRecord;
        const inTok = Number(u.input_tokens || 0);
        const outTok = Number(u.output_tokens || 0);
        await markRelayAccountSuccess(account.id, { tokensIn: inTok, tokensOut: outTok });
        return { input_tokens: inTok, output_tokens: outTok };
      } catch {
        await markRelayAccountSuccess(account.id);
        return null;
      }
    }

    await markRelayAccountSuccess(account.id);
    void requestedModel;
    return null;
  }
}

export default RelayPoolExecutor;
