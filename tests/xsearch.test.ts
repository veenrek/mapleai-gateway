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

test("web search price", async () => {
  const { webSearchPriceFor, webSearchBaseUsd, webSearchPerResultUsd } = await import("../src/websearch.ts");
  assert.equal(webSearchPriceFor({ query: "q" }), webSearchBaseUsd + webSearchPerResultUsd * 10);
  assert.equal(webSearchPriceFor({ query: "q", max_results: 25 }), webSearchBaseUsd + webSearchPerResultUsd * 25);
});

test("x/search json posts parser", async () => {
  const { parseXSearchJsonPosts } = await import("../src/xsearch.ts");
  const { extractJson } = await import("../src/xintel.ts");
  const good = JSON.stringify({ output_text: '{"posts":[{"url":"https://x.com/a/status/1","author":"a"}]}' });
  assert.ok(parseXSearchJsonPosts(good, extractJson));
  const fenced = JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: '```json\n{"posts":[]}\n```' }] }] });
  assert.ok(parseXSearchJsonPosts(fenced, extractJson));
  assert.equal(parseXSearchJsonPosts(JSON.stringify({ output_text: "no json" }), extractJson), undefined);
  assert.equal(parseXSearchJsonPosts("not-json-body", extractJson), undefined);
});

test("x/search hours_back validation", async () => {
  const { validateXSearch } = await import("../src/xsearch.ts");
  const run = (body: unknown): number => {
    let statusCode = 0; let called = false;
    validateXSearch({ body } as never, { status(code: number) { statusCode = code; return { json() {} }; } } as never, () => { called = true; });
    return called ? 200 : statusCode;
  };
  assert.equal(run({ query: "q", hours_back: 24 }), 200);
  assert.equal(run({ query: "q", hours_back: 168 }), 200);
  assert.equal(run({ query: "q", hours_back: 0 }), 400);
  assert.equal(run({ query: "q", hours_back: 169 }), 400);
  assert.equal(run({ query: "q", format: "json", hours_back: 48 }), 200);
  assert.equal(run({ query: "q", format: "yaml" }), 400);
});
