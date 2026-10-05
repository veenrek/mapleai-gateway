import test from "node:test";
import assert from "node:assert/strict";

const { capJson, captureResponse } = await import("../src/data-log.ts");

test("capJson redacts secrets and caps long strings", () => {
  const out = capJson({
    model: "gpt-6-luna",
    messages: [{ role: "user", content: "x".repeat(3000) }],
    authorization: "Bearer abc",
    nested: { payment_signature: "sig", note: "kept" },
  }) as Record<string, unknown>;
  assert.equal(out.authorization, "«redacted»");
  assert.equal((out.nested as Record<string, unknown>).payment_signature, "«redacted»");
  assert.equal((out.nested as Record<string, unknown>).note, "kept");
  const first = (out.messages as Array<{ content: string }>)[0].content;
  assert.match(first, /truncated 952 chars/);
});

test("capJson keeps small bodies intact", () => {
  const out = capJson({ model: "m", messages: [{ role: "user", content: "hi" }] });
  assert.deepEqual(out, { model: "m", messages: [{ role: "user", content: "hi" }] });
});

test("captureResponse preserves JSON bodies", () => {
  const sent: string[] = [];
  const res = {
    header: "application/json",
    segments: [] as unknown[],
    write(chunk: unknown) { sent.push(String(chunk)); return true; },
    end(chunk?: unknown) { if (chunk !== undefined) sent.push(String(chunk)); return this; },
    getHeader() { return this.header; },
  } as never;
  const cap = captureResponse(res);
  res.write('{"ok":true,"choices":[{"message":{"content":"10081"}}]}');
  res.end();
  const out = cap.read() as Record<string, unknown>;
  assert.equal(out.ok, true);
  assert.equal((out.choices as Array<{ message: { content: string } }>)[0].message.content, "10081");
});

test("captureResponse marks binary media without storing bytes", () => {
  const res = {
    header: "audio/wav",
    write() { return true; },
    end() { return this; },
    getHeader() { return this.header; },
  } as never;
  const cap = captureResponse(res);
  res.end("RIFFfake");
  assert.match(String(cap.read()), /binary audio\/wav/);
});
