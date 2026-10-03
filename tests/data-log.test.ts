import test from "node:test";
import assert from "node:assert/strict";

const { capJson } = await import("../src/data-log.ts");

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
