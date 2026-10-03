import test from "node:test";
import assert from "node:assert/strict";

const {
  validateXDigest, validateXSentiment, validateXFactcheck,
  digestPrice, sentimentPrice, factcheckPrice, extractJson,
  validateXProfile, validateXMedia, profilePrice, mediaPrice,
  profileBaseUsd, profilePerHandleUsd, mediaBaseUsd, mediaPerResultUsd,
  digestBaseUsd, digestPerHandleUsd, digestMediaUsd,
  sentimentBaseUsd, sentimentPerExampleUsd, sentimentPerDayUsd,
  factcheckBaseUsd, factcheckPerSourceUsd,
} = await import("../src/xintel.ts");

function runValidation(validate: (req: never, res: never, next: () => void) => void, body: unknown): number {
  let statusCode = 0;
  let called = false;
  validate({ body } as never, {
    status(code: number) { statusCode = code; return { json() { /* drain */ } }; },
  } as never, () => { called = true; });
  return called ? 200 : statusCode;
}

test("digest validator", () => {
  assert.equal(runValidation(validateXDigest, { handles: ["base"] }), 200);
  assert.equal(runValidation(validateXDigest, { handles: ["@base", "jessepollak"], hours_back: 168, max_posts_per_handle: 5, include_media: true }), 200);
  assert.equal(runValidation(validateXDigest, {}), 400);
  assert.equal(runValidation(validateXDigest, { handles: [] }), 400);
  assert.equal(runValidation(validateXDigest, { handles: ["not a handle!"] }), 400);
  assert.equal(runValidation(validateXDigest, { handles: Array(21).fill("a") }), 400);
  assert.equal(runValidation(validateXDigest, { handles: ["base"], hours_back: 0 }), 400);
  assert.equal(runValidation(validateXDigest, { handles: ["base"], hours_back: 169 }), 400);
});

test("digest handles normalize (@ and case)", () => {
  const body: Record<string, unknown> = { handles: ["@Base", "JESSEpollak"] };
  let passed: unknown;
  validateXDigest({ body } as never, { status() { throw new Error("should not fail"); } } as never, () => { passed = body.handles; });
  assert.deepEqual(passed, ["base", "jessepollak"]);
});

test("digest price", () => {
  assert.equal(digestPrice({ handles: ["a"] }), digestBaseUsd + digestPerHandleUsd);
  assert.equal(digestPrice({ handles: ["a", "b", "c"], include_media: true }), digestBaseUsd + digestPerHandleUsd * 3 + digestMediaUsd);
});

test("sentiment validator", () => {
  assert.equal(runValidation(validateXSentiment, { topic: "x402" }), 200);
  assert.equal(runValidation(validateXSentiment, { topic: "x", hours_back: 168, max_examples: 10, min_engagement: 20 }), 200);
  assert.equal(runValidation(validateXSentiment, {}), 400);
  assert.equal(runValidation(validateXSentiment, { topic: "" }), 400);
  assert.equal(runValidation(validateXSentiment, { topic: "x".repeat(201) }), 400);
  assert.equal(runValidation(validateXSentiment, { topic: "x", max_examples: 11 }), 400);
});

test("sentiment price", () => {
  assert.equal(sentimentPrice({}), sentimentBaseUsd + sentimentPerExampleUsd * 5);
  assert.equal(sentimentPrice({ max_examples: 1, hours_back: 24 }), sentimentBaseUsd + sentimentPerExampleUsd);
  assert.equal(sentimentPrice({ max_examples: 5, hours_back: 72 }), sentimentBaseUsd + sentimentPerExampleUsd * 5 + sentimentPerDayUsd * 2);
});

test("factcheck validator", () => {
  assert.equal(runValidation(validateXFactcheck, { claim: "USDT on Bitcoin" }), 200);
  assert.equal(runValidation(validateXFactcheck, { claim: "x", max_sources: 10, days_back: 30 }), 200);
  assert.equal(runValidation(validateXFactcheck, {}), 400);
  assert.equal(runValidation(validateXFactcheck, { claim: "x".repeat(1001) }), 400);
  assert.equal(runValidation(validateXFactcheck, { claim: "x", days_back: 31 }), 400);
});

test("factcheck price", () => {
  assert.equal(factcheckPrice({}), factcheckBaseUsd + factcheckPerSourceUsd * 6);
  assert.equal(factcheckPrice({ max_sources: 1 }), factcheckBaseUsd + factcheckPerSourceUsd);
});

test("extractJson tolerates fences and prose", () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('here is the answer: {"a":2} hope it helps'), { a: 2 });
  assert.equal(extractJson("no json at all"), undefined);
  assert.equal(extractJson("{broken"), undefined);
});

test("profile validator + price", () => {
  assert.equal(runValidation(validateXProfile, { handles: ["base"] }), 200);
  assert.equal(runValidation(validateXProfile, { handles: ["@VitalikButerin"], days_back: 30, include_posts: false }), 200);
  assert.equal(runValidation(validateXProfile, { handles: [] }), 400);
  assert.equal(runValidation(validateXProfile, { handles: ["a","b","c","d","e","f"] }), 400);
  assert.equal(runValidation(validateXProfile, { handles: ["base"], days_back: 31 }), 400);
  assert.equal(profilePrice({ handles: ["a", "b"] }), profileBaseUsd + profilePerHandleUsd * 2);
});

test("media validator + price", () => {
  assert.equal(runValidation(validateXMedia, { query: "dashboard screenshots" }), 200);
  assert.equal(runValidation(validateXMedia, { query: "q", media_type: "both", max_results: 15, hours_back: 168 }), 200);
  assert.equal(runValidation(validateXMedia, {}), 400);
  assert.equal(runValidation(validateXMedia, { query: "x".repeat(501) }), 400);
  assert.equal(runValidation(validateXMedia, { query: "q", media_type: "gif" }), 400);
  assert.equal(runValidation(validateXMedia, { query: "q", max_results: 16 }), 400);
  assert.equal(mediaPrice({}), mediaBaseUsd + mediaPerResultUsd * 8);
  assert.equal(mediaPrice({ max_results: 3 }), mediaBaseUsd + mediaPerResultUsd * 3);
});
