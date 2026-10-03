import test from "node:test";
import assert from "node:assert/strict";

const { validateXSearch, xSearchPriceFor, xSearchBasePriceUsd, xSearchPerResultUsd, xSearchWebPriceUsd, xSearchModel } = await import("../src/xsearch.ts");

function fakeReq(body: unknown) {
  return { body } as never;
}

function runValidation(body: unknown): { statusCode: number } {
  let statusCode = 0;
  let called = false;
  validateXSearch(fakeReq(body), {
    status(code: number) { statusCode = code; return { json() { /* drain */ } }; },
  } as never, () => { called = true; });
  return { statusCode: called ? 200 : statusCode };
}

test("accepts a minimal valid query", () => {
  assert.equal(runValidation({ query: "trending on x" }).statusCode, 200);
});

test("accepts all optional fields", () => {
  const res = runValidation({ query: "q", max_results: 25, include_web: true, instructions: "be terse" });
  assert.equal(res.statusCode, 200);
});

test("rejects bad bodies", () => {
  assert.equal(runValidation(undefined).statusCode, 400);
  assert.equal(runValidation({}).statusCode, 400);
  assert.equal(runValidation({ query: "   " }).statusCode, 400);
  assert.equal(runValidation({ query: "x".repeat(2001) }).statusCode, 400);
  assert.equal(runValidation({ query: "q", max_results: 0 }).statusCode, 400);
  assert.equal(runValidation({ query: "q", max_results: 26 }).statusCode, 400);
  assert.equal(runValidation({ query: "q", max_results: 2.5 }).statusCode, 400);
  assert.equal(runValidation({ query: "q", include_web: "yes" }).statusCode, 400);
});

test("defaults and price look sane", () => {
  assert.equal(xSearchModel, process.env.X_SEARCH_COMBO_MODEL ?? "grok-4.6-search");
  assert.ok(xSearchBasePriceUsd > 0 && xSearchPerResultUsd > 0);
});

test("price scales with max_results and include_web", () => {
  const def = xSearchPriceFor({ query: "q" });
  assert.equal(def, xSearchBasePriceUsd + xSearchPerResultUsd * 10);
  assert.equal(xSearchPriceFor({ query: "q", max_results: 1 }), xSearchBasePriceUsd + xSearchPerResultUsd);
  assert.equal(xSearchPriceFor({ query: "q", max_results: 25 }), xSearchBasePriceUsd + xSearchPerResultUsd * 25);
  assert.equal(xSearchPriceFor({ query: "q", include_web: true }), def + xSearchWebPriceUsd);
});
