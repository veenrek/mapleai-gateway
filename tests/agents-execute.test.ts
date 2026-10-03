import test from "node:test";
import assert from "node:assert/strict";
import type { NextFunction, Request, Response } from "express";

const { validateAgentsExecute, agentsModels, parseExaResults, runDataAnalysis, formatPistonResult, codeExecEnabled } =
  await import("../src/agents.ts");

test("runDataAnalysis computes stats over numbers", () => {
  const out = JSON.parse(runDataAnalysis([1, 2, 3, 4]));
  assert.deepEqual(out, { count: 4, sum: 10, mean: 2.5, median: 2.5, min: 1, max: 4, stdev: 1.118034 });
});

test("runDataAnalysis reads object fields and rejects bad data", () => {
  const out = JSON.parse(runDataAnalysis([{ price: 2 }, { price: 4 }], "price"));
  assert.equal(out.count, 2);
  assert.equal(out.field, "price");
  assert.equal(out.mean, 3);
  assert.match(runDataAnalysis([1, "oops"]), /non-numeric/);
  assert.match(runDataAnalysis("string"), /must be an array/);
  assert.match(runDataAnalysis([]), /empty/);
});

test("parseExaResults reads Exa MCP plain-text blocks", () => {
  const text = [
    "Title: GPT-6.1 Sol Model | OpenAI API",
    "URL: https://developers.openai.com/api/docs/models/gpt-6.1-sol",
    "Published: N/A",
    "Author: N/A",
    "Highlights:",
    "GPT-6.1 Sol delivers near-Astra performance at a lower cost.",
    "...",
    "1,050,000 context window",
    "",
    "Title: Another result",
    "URL: https://example.com/a",
    "Highlights:",
    "second highlight text",
  ].join("\n");
  const items = parseExaResults({ content: [{ type: "text", text }] });
  assert.equal(items.length, 2);
  assert.equal(items[0].url, "https://developers.openai.com/api/docs/models/gpt-6.1-sol");
  assert.match(items[0].snippet, /near-Astra/);
  assert.equal(items[1].title, "Another result");
});

function invokeValidator(body: unknown) {
  const state: { status: number; response: unknown; nextCalled: boolean } = {
    status: 200,
    response: null,
    nextCalled: false,
  };
  const res = {
    locals: {},
    status(code: number) {
      state.status = code;
      return this;
    },
    json(payload: unknown) {
      state.response = payload;
      return this;
    },
  };
  validateAgentsExecute(
    { body } as unknown as Request,
    res as unknown as Response,
    (() => { state.nextCalled = true; }) as NextFunction,
  );
  return state;
}

test("both engines are advertised", () => {
  assert.deepEqual([...agentsModels].sort(), ["agents/gpt-6-sol", "agents/oss-20b"].sort());
});

test("accepts both engines with the stream flag", () => {
  for (const model of agentsModels) {
    const state = invokeValidator({ model, task: "ping", max_steps: 2, stream: true });
    assert.ok(state.nextCalled, `${model} must pass validation`);
  }
});

test("rejects unknown engine", () => {
  const state = invokeValidator({ model: "agents/gpt-9", task: "ping" });
  assert.equal(state.status, 400);
  assert.ok(!state.nextCalled);
});

test("rejects missing task and oversized steps", () => {
  assert.equal(invokeValidator({ model: agentsModels[0] }).status, 400);
  assert.equal(invokeValidator({ model: agentsModels[0], task: "ping", max_steps: 99 }).status, 400);
});

test("formatPistonResult renders run and compile outcomes", () => {
  const ok = formatPistonResult("python", { run: { stdout: "4\n", stderr: "", code: 0 } });
  assert.match(ok, /^code_exec python: exit code 0/);
  assert.match(ok, /stdout:\n4/);

  const compileFail = formatPistonResult("python", {
    compile: { stdout: "", stderr: "SyntaxError: bad", code: 1, output: "SyntaxError: bad" },
  });
  assert.match(compileFail, /compile error/);
  assert.match(compileFail, /SyntaxError/);

  const apiError = formatPistonResult("python", { message: "runtime unavailable" });
  assert.match(apiError, /^error: runtime unavailable/);

  const loud = formatPistonResult("python", { run: { stdout: "x".repeat(10_000), stderr: "", code: 0 } });
  assert.ok(loud.length <= 6000);
});

test("code_exec validators follow the executor flag", async () => {
  // Default test env: CODE_EXEC_PROVIDER unset → tool is gated off.
  assert.equal(codeExecEnabled, false);
  const rejected = invokeValidator({ task: "ping", tools: ["code_exec"] });
  assert.equal(rejected.status, 400);
  assert.match(JSON.stringify(rejected.response), /disabled on this deployment/);

  process.env.CODE_EXEC_PROVIDER = "piston";
  try {
    const { validateAgentsExecute: validateWithExec } = await import("../src/agents.ts?executor=piston");
    const accepted = (() => {
      const state = { status: 200, response: null as unknown, nextCalled: false };
      const res = {
        locals: {},
        status(code: number) { state.status = code; return this; },
        json(payload: unknown) { state.response = payload; return this; },
      };
      validateWithExec(
        { body: { task: "ping", tools: ["code_exec"] } } as unknown as Request,
        res as unknown as Response,
        (() => { state.nextCalled = true; }) as NextFunction,
      );
      return state;
    })();
    assert.ok(accepted.nextCalled, "code_exec must pass validation when the executor is enabled");
  } finally {
    delete process.env.CODE_EXEC_PROVIDER;
  }
});
