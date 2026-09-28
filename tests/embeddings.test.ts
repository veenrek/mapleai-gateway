import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { NextFunction, Request, Response } from "express";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mapleai-embedding-validation-"));
process.env.EMBEDDING_DATA_FILE = path.join(tempDir, "embedding-data.jsonl");

const { embeddingRequestSchema, validateEmbedding } = await import("../src/embeddings.ts");

function invokeValidator(body: unknown) {
  const state: { status: number; response: unknown; nextCalled: boolean; headers: Record<string, string> } = {
    status: 200,
    response: null,
    nextCalled: false,
    headers: {},
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
    setHeader(name: string, value: string) {
      state.headers[name.toLowerCase()] = value;
      return this;
    },
  };
  validateEmbedding(
    { body, get: () => "test.mapleai.shop" } as unknown as Request,
    res as unknown as Response,
    (() => { state.nextCalled = true; }) as NextFunction
  );
  return state;
}

after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("invalid input returns the exact contract and records the rejected input without a vector", () => {
  const body = { input: { text: "diagnostic invalid input" } };
  const result = invokeValidator(body);
  const payload = result.response as {
    error: { code: string; param: string; details: { schema: unknown } };
  };

  assert.equal(result.status, 400);
  assert.equal(result.nextCalled, false);
  assert.equal(payload.error.code, "invalid_input");
  assert.equal(payload.error.param, "input");
  assert.deepEqual(payload.error.details.schema, embeddingRequestSchema);

  const [event] = fs
    .readFileSync(process.env.EMBEDDING_DATA_FILE!, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(event.input, body.input);
  assert.equal(event.status, 400);
  assert.equal(event.failure.reason, "invalid_input_type");
  assert.equal("vectors" in event, false);
});

test("oversized invalid input is truncated in the private data log", () => {
  const largeText = "x".repeat(20_000);
  const result = invokeValidator({ input: { text: largeText } });
  assert.equal(result.status, 400);

  const events = fs
    .readFileSync(process.env.EMBEDDING_DATA_FILE!, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const event = events.at(-1);
  assert.equal(event.inputTruncated, true);
  assert.ok(event.input.preview.length <= 16_384);
  assert.equal("vectors" in event, false);
});

test("discovery probe (model-only body) gets a 200 with an empty list and a hint", () => {
  const result = invokeValidator({ model: "nvidia/nemotron-3-embed-1b" });
  const payload = result.response as { object: string; data: unknown[]; model: string; hint: string; hint_next: string };

  assert.equal(result.status, 200);
  assert.equal(result.nextCalled, false);
  assert.equal(payload.object, "list");
  assert.deepEqual(payload.data, []);
  assert.equal(payload.model, "nvidia/nemotron-3-embed-1b");
  assert.ok(payload.hint.includes("input"));
  assert.ok(payload.hint_next.includes("/v1/chat/completions"));
  assert.equal(result.headers["x-mapleai-next"], "/v1/chat/completions");

  const events = fs
    .readFileSync(process.env.EMBEDDING_DATA_FILE!, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const event = events.at(-1);
  assert.equal(event.status, 200);
  assert.equal(event.failure.reason, "missing_input");
  assert.equal("vectors" in event, false);
});

test("missing, empty, oversized, and mixed-type inputs return descriptive errors", () => {
  const cases: Array<{ body: unknown; param: string; message: string }> = [
    { body: {}, param: "input", message: "input is required." },
    { body: { input: [] }, param: "input", message: "input array must not be empty." },
    {
      body: { input: Array.from({ length: 129 }, () => "x") },
      param: "input",
      message: "input array must contain no more than 128 strings.",
    },
    {
      body: { input: ["valid", 42] },
      param: "input",
      message: "Every item in the input array must be a string.",
    },
  ];

  for (const item of cases) {
    const result = invokeValidator(item.body);
    const payload = result.response as { error: { message: string; param: string; code: string } };
    assert.equal(result.status, 400);
    assert.equal(payload.error.code, "invalid_input");
    assert.equal(payload.error.param, item.param);
    assert.equal(payload.error.message, item.message);
  }
});

test("valid strings and string arrays pass through to the upstream handler", () => {
  for (const input of ["Hello", ["Hello", "World"]]) {
    const result = invokeValidator({ input });
    assert.equal(result.nextCalled, true);
    assert.equal(result.status, 200);
  }
});
