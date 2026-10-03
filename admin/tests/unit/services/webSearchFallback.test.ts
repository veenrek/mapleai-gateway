import test from "node:test";
import assert from "node:assert/strict";

const { prepareWebSearchFallbackBody, supportsNativeWebSearchFallbackBypass } = await import(
  "../../../open-sse/services/webSearchFallback.ts"
);

const bodyWithWebSearch = {
  model: "grok-4.6",
  input: "hi",
  tools: [{ type: "x_search" }, { type: "web_search" }],
};

test("nativeWebSearch flag bypasses the fallback, tools pass through untouched", () => {
  const { body, fallback } = prepareWebSearchFallbackBody(bodyWithWebSearch, {
    provider: "openai-compatible-responses-abc",
    sourceFormat: "openai-responses",
    targetFormat: "openai-responses",
    nativeCodexPassthrough: false,
    providerSpecificData: { nativeWebSearch: true },
  });
  assert.equal(fallback.enabled, false);
  assert.deepEqual(body.tools, bodyWithWebSearch.tools);
});

test("flag supportsNativeWebSearchFallbackBypass alone triggers the bypass", () => {
  assert.equal(
    supportsNativeWebSearchFallbackBypass({
      targetFormat: "openai-responses",
      nativeCodexPassthrough: false,
      providerSpecificData: { nativeWebSearch: true },
    }),
    true
  );
});

test("without the flag, responses targets still get the omniroute fallback tool", () => {
  const { body, fallback } = prepareWebSearchFallbackBody(bodyWithWebSearch, {
    provider: "openai-compatible-chat-abc",
    sourceFormat: "openai-responses",
    targetFormat: "openai-responses",
    nativeCodexPassthrough: false,
    providerSpecificData: null,
  });
  assert.equal(fallback.enabled, true);
  const types = body.tools.map((t) => t.type ?? t.function?.type);
  assert.ok(!body.tools.some((t) => t.type === "web_search"));
  assert.equal(fallback.toolName, "omniroute_web_search");
});
