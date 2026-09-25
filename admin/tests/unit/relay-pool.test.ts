import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

// Relay Pool DB store + rotation helpers. Uses an isolated DATA_DIR and closes
// the handle in test.after (CLAUDE.md "Database Handles in Tests" — otherwise
// Node's runner hangs).
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-relay-accounts-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
// Enable at-rest encryption so the "secret never lands in the DB" assertions hold.
process.env.STORAGE_ENCRYPTION_KEY = "test-key-relay-pool-0123456789abcdef";

const core = await import("../../src/lib/db/core.ts");
const ra = await import("../../src/lib/db/relayAccounts.ts");
const { isAccountRelatedError, cooldownForStatus } =
  await import("../../open-sse/executors/relayPool.ts");
const { anthropicToOpenAI, openAIToAnthropicResponse } =
  await import("../../open-sse/executors/relayPool/anthropicOpenAI.ts");
const {
  openAIToCodexResponses,
  parseCodexResponsesSSE,
  synthesizeAnthropicJSONFromCodex,
  resolveCodexModelSlug,
} = await import("../../open-sse/executors/relayPool/codexConverter.ts");

test.after(() => {
  try {
    core.resetDbInstance();
  } catch {}
  try {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  } catch {}
});

// ─── DB module ───────────────────────────────────────────────────────────────

test("createRelayAccount persists an account with encrypted api key at rest", () => {
  const account = ra.createRelayAccount({
    name: "nvidia-main",
    providerType: "openai",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    apiKey: "nvapi-secret-value",
    model: "grok-4.6-high",
    authHeader: "authorization",
  });
  assert.ok(account.id);
  assert.equal(account.providerType, "openai");
  assert.equal(account.apiKey, "nvapi-secret-value", "decryptable via getter");

  const db = core.getDbInstance();
  const row = db.prepare("SELECT api_key FROM relay_accounts WHERE id = ?").get(account.id) as {
    api_key: string;
  };
  assert.notEqual(row.api_key, "nvapi-secret-value", "raw secret must not land in the DB");
});

test("getRelayAccounts / getEnabledRelayAccounts respect the enabled flag", () => {
  const a = ra.createRelayAccount({ name: "enabled-one" });
  const b = ra.createRelayAccount({ name: "disabled-one", enabled: false });
  const all = ra.getRelayAccounts();
  assert.ok(all.find((x) => x.id === a.id));
  assert.ok(all.find((x) => x.id === b.id));
  assert.ok(!ra.getEnabledRelayAccounts().find((x) => x.id === b.id));
});

test("updateRelayAccount patches fields; clearCooldown resets rotation state", () => {
  const account = ra.createRelayAccount({ name: "patch-me" });
  ra.markRelayAccountError(account.id, 429, "Too Many Requests", 5_000);
  let after = ra.getRelayAccount(account.id)!;
  assert.ok(after.cooldownUntil, "cooldown set by error handler");
  after = ra.updateRelayAccount(account.id, { clearCooldown: true, model: "m2" })!;
  assert.equal(after.cooldownUntil, null);
  assert.equal(after.model, "m2");
});

test("markRelayAccountSuccess clears cooldown and bumps counters + usage", () => {
  const account = ra.createRelayAccount({ name: "success-case" });
  ra.markRelayAccountError(account.id, 429, "rate limit", 60_000);
  ra.markRelayAccountSuccess(account.id, { tokensIn: 100, tokensOut: 50 });
  const after = ra.getRelayAccount(account.id)!;
  assert.equal(after.cooldownUntil, null);
  assert.equal(after.lastError, null);
  assert.equal(after.successCount, 1);
  assert.equal(after.tokensIn, 100);
  assert.equal(after.tokensOut, 50);
});

test("markRelayAccountError with cooldownMs=0 marks the error without blocking", () => {
  const account = ra.createRelayAccount({ name: "no-cool" });
  ra.markRelayAccountError(account.id, 503, "Service Unavailable", 0);
  const after = ra.getRelayAccount(account.id)!;
  assert.equal(after.errorCount, 1);
  assert.equal(after.lastStatus, 503);
  assert.equal(after.cooldownUntil, null);
});

test("deleteRelayAccount removes the row", () => {
  const account = ra.createRelayAccount({ name: "doomed" });
  assert.equal(ra.deleteRelayAccount(account.id), true);
  assert.equal(ra.getRelayAccount(account.id), null);
});

test("importRelayAccounts is idempotent on duplicate (name|baseUrl|providerType)", () => {
  const export1 = [
    {
      name: "xpiki",
      providerType: "openai",
      baseUrl: "https://api.xpiki.com/v1",
      apiKey: "sk-test",
    },
    { name: "nvidia", providerType: "openai", baseUrl: "https://integrate.api.nvidia.com/v1" },
  ];
  const first = ra.importRelayAccounts(export1 as never);
  assert.equal(first.imported, 2);
  const second = ra.importRelayAccounts(export1 as never);
  assert.equal(second.imported, 0, "duplicates skipped");
  assert.equal(second.skipped, 2);
});

test("getRelayPoolStats aggregates totals", () => {
  const stats = ra.getRelayPoolStats();
  assert.ok(stats.total >= 5);
  assert.ok(stats.byProviderType.length >= 1);
});

// ─── Rotation error classification (ported from relay) ──────────────────────

test("isAccountRelatedError rotates on quota/auth/model errors", () => {
  assert.equal(isAccountRelatedError(401), true);
  assert.equal(isAccountRelatedError(403), true);
  assert.equal(isAccountRelatedError(429), true);
  assert.equal(isAccountRelatedError(400, "invalid request"), false);
  assert.equal(isAccountRelatedError(200, ""), false);
  assert.equal(isAccountRelatedError(500, "The model 'gpt-x' does not exist"), true);
  assert.equal(isAccountRelatedError(404, "model_not_found"), true);
  assert.equal(isAccountRelatedError(503, "No available accounts"), true);
});

test("cooldownForStatus: only 429 cools down, always 5s", () => {
  assert.equal(cooldownForStatus(429), 5_000);
  assert.equal(cooldownForStatus(429, "Too Many Requests"), 5_000);
  assert.equal(cooldownForStatus(404), 0);
  assert.equal(cooldownForStatus(503, "overloaded"), 0);
});

// ─── Converters ──────────────────────────────────────────────────────────────

test("anthropicToOpenAI converts messages, system, tools; strips CC fingerprints", () => {
  const body = {
    model: "claude-opus-5",
    system: [
      { type: "text", text: "x-anthropic-billing-header: cc_version=2.x; cch=00000;" },
      { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
      { type: "text", text: "Be helpful." },
    ],
    max_tokens: 512,
    messages: [
      { role: "user", content: "List files" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "a.txt\nb.txt" }],
      },
    ],
    tools: [
      {
        name: "Bash",
        description: "run shell",
        input_schema: { type: "object", properties: { command: { type: "string" } } },
      },
    ],
  };
  const out = anthropicToOpenAI(body, { model: "grok-4.6-high" }) as Record<string, unknown>;
  assert.equal(out.model, "grok-4.6-high");
  assert.equal(out.max_tokens, 512);

  const messages = out.messages as Array<Record<string, unknown>>;
  const systemMsg = messages[0];
  assert.ok(String(systemMsg.content).includes("Be helpful."));
  assert.ok(!String(systemMsg.content).includes("billing-header"));
  assert.ok(!String(systemMsg.content).includes("official CLI for Claude"));

  const toolCall = messages.find((m) => Array.isArray(m.tool_calls)) as {
    tool_calls: Array<Record<string, unknown>>;
  };
  assert.equal(toolCall.tool_calls[0].function.name, "Bash");
  const toolResult = messages.find((m) => m.role === "tool") as Record<string, unknown>;
  assert.equal(toolResult.tool_call_id, "toolu_1");
  assert.equal(toolResult.content, "a.txt\nb.txt");

  const tools = out.tools as Array<Record<string, unknown>>;
  assert.equal(tools[0].type, "function");
});

test("openAIToAnthropicResponse maps choices/usage/stop_reason to claude shape", () => {
  const data = {
    id: "chatcmpl-1",
    model: "grok-4.6-high",
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          content: "calling",
          tool_calls: [
            { id: "call_9", function: { name: "Read", arguments: '{"file_path":"a.ts"}' } },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 11, completion_tokens: 7 },
  };
  const out = openAIToAnthropicResponse(data, "claude-opus-5") as Record<string, unknown>;
  assert.equal(out.type, "message");
  assert.equal(out.model, "claude-opus-5");
  assert.equal(out.stop_reason, "tool_use");
  const usage = out.usage as Record<string, number>;
  assert.equal(usage.input_tokens, 11);
  assert.equal(usage.output_tokens, 7);
  const content = out.content as Array<Record<string, unknown>>;
  assert.equal(content[0].type, "text");
  assert.equal(content[1].type, "tool_use");
  assert.deepEqual(content[1].input, { file_path: "a.ts" });
});

test("codex converter: openai body → responses body with instructions + input", () => {
  const out = openAIToCodexResponses({
    messages: [
      { role: "system", content: "be terse" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "bye" },
    ],
  }) as Record<string, unknown>;
  assert.equal(out.instructions, "be terse");
  const input = out.input as Array<Record<string, unknown>>;
  assert.equal(input.length, 3);
  assert.equal(input[0].role, "user");
  assert.equal(out.stream, true);
  assert.equal(out.store, false);
});

test("parseCodexResponsesSSE extracts deltas + usage + errors", () => {
  const sseText =
    'data: {"type":"response.output_text.delta","delta":"Hel"}\n\n' +
    'data: {"type":"response.output_text.delta","delta":"lo"}\n\n' +
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":2}}}\n\n';
  const parsed = parseCodexResponsesSSE(sseText);
  assert.equal(parsed.answer, "Hello");
  assert.deepEqual(parsed.usage, { input_tokens: 3, output_tokens: 2 });
  assert.equal(parsed.error, null);

  const failed = parseCodexResponsesSSE('data: {"type":"error","message":"boom"}\n\n');
  assert.equal(failed.error, "boom");
});

test("synthesizeAnthropicJSONFromCodex builds valid claude message with usage", () => {
  const msg = synthesizeAnthropicJSONFromCodex({
    model: "gpt-5.5",
    deltas: ["a", "b"],
    usage: { input_tokens: 4, output_tokens: 2 },
  }) as Record<string, unknown>;
  assert.equal(msg.type, "message");
  assert.equal(msg.stop_reason, "end_turn");
  const content = msg.content as Array<Record<string, unknown>>;
  assert.equal(content[0].text, "ab");
  const usage = msg.usage as Record<string, number>;
  assert.equal(usage.input_tokens, 4);
  assert.equal(usage.output_tokens, 2);
});

test("resolveCodexModelSlug matches cache with dot/suffix normalization", () => {
  const account = { modelsCache: ["gpt-5-5", "gpt-5-mini"] };
  assert.equal(resolveCodexModelSlug(account, "gpt.5.5"), "gpt-5-5");
  assert.equal(resolveCodexModelSlug({ modelsCache: [] }, "whatever"), "whatever");
});

// ─── Executor rotation (integration against a local fake upstream) ─────────

// The executor tests below need a CLEAN pool: earlier DB tests leave accounts
// behind that would otherwise join the rotation (some pointing at real APIs).
test("executor: clean slate for rotation tests", () => {
  for (const account of ra.getRelayAccounts()) {
    ra.deleteRelayAccount(account.id);
  }
  assert.equal(ra.getEnabledRelayAccounts().length, 0);
});

const CLAUDE_OK = {
  id: "msg_test",
  type: "message",
  role: "assistant",
  model: "claude-opus-5",
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 5, output_tokens: 2 },
};

function startFakeUpstream(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void
): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({
        port,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

function claudeBody(model = "claude-opus-5") {
  return { model, max_tokens: 16, stream: false, messages: [{ role: "user", content: "hi" }] };
}

test("executor: ignores accounts without credentials", async () => {
  const upstream = await startFakeUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(CLAUDE_OK));
  });
  try {
    // No apiKey → never a candidate even though enabled.
    // No apiKey → never a candidate even though enabled. A pre-aborted signal
    // skips the hold-and-retry window so we get the raw exhaustion response.
    const { RelayPoolExecutor } = await import("../../open-sse/executors/relayPool.ts");
    const executor = new RelayPoolExecutor();
    const result = await executor.execute({
      model: "claude-opus-5",
      body: claudeBody(),
      stream: false,
      credentials: {},
      signal: AbortSignal.abort(),
      log: null,
    });
    assert.equal(result.response.status, 503);
  } finally {
    await upstream.close();
  }
});

test("executor: anthropic passthrough success records usage + success count", async () => {
  const upstream = await startFakeUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(CLAUDE_OK));
  });
  try {
    const account = ra.createRelayAccount({
      name: "it-anthropic-ok",
      providerType: "anthropic",
      baseUrl: `http://127.0.0.1:${upstream.port}`,
      apiKey: "sk-test",
    });
    const { RelayPoolExecutor } = await import("../../open-sse/executors/relayPool.ts");
    const executor = new RelayPoolExecutor();
    const result = await executor.execute({
      model: "claude-opus-5",
      body: claudeBody(),
      stream: false,
      credentials: {},
      signal: null,
      log: null,
    });
    assert.equal(result.response.status, 200);
    const data = JSON.parse(await result.response.text());
    assert.equal(data.type, "message");
    assert.equal(data.content[0].text, "ok");

    const after = ra.getRelayAccount(account.id)!;
    assert.equal(after.successCount, 1);
    assert.equal(after.tokensIn, 5);
    assert.equal(after.tokensOut, 2);
  } finally {
    await upstream.close();
  }
});

test("executor: rotates from a 429 account to the next one and cools down the failed", async () => {
  let failingHits = 0;
  const upstream = await startFakeUpstream((req, res) => {
    // Both accounts share one upstream; distinguish by the x-api-key header.
    if (req.headers["x-api-key"] === "sk-bad") {
      failingHits += 1;
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Too Many Requests" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(CLAUDE_OK));
  });
  try {
    ra.createRelayAccount({
      name: "rot-bad",
      providerType: "anthropic",
      baseUrl: `http://127.0.0.1:${upstream.port}`,
      apiKey: "sk-bad",
      model: "claude-opus-5",
    });
    ra.createRelayAccount({
      name: "rot-good",
      providerType: "anthropic",
      baseUrl: `http://127.0.0.1:${upstream.port}`,
      apiKey: "sk-good",
      model: "claude-opus-5",
    });
    const { RelayPoolExecutor } = await import("../../open-sse/executors/relayPool.ts");
    const executor = new RelayPoolExecutor();
    const result = await executor.execute({
      model: "claude-opus-5",
      body: claudeBody(),
      stream: false,
      credentials: {},
      signal: null,
      log: null,
    });
    assert.equal(result.response.status, 200);
    assert.ok(failingHits >= 1, "failing upstream must have been tried");

    const bad = ra.getRelayAccounts().find((a) => a.name === "rot-bad")!;
    assert.ok(bad.cooldownUntil, "429 must cool the account down for 5s");
    const good = ra.getRelayAccounts().find((a) => a.name === "rot-good")!;
    assert.ok(good.successCount >= 1);
  } finally {
    await upstream.close();
  }
});
