import test from "node:test";
import assert from "node:assert/strict";

const { buildPaymentRequiredBody, paymentRequiredBodyMiddleware } =
  await import("../src/payment-required-body.ts");

const flags = { embeddingsEnabled: true, freeGptOssEnabled: true };

test("body points at pricing, docs, the free tier and the starter repo", () => {
  const body = buildPaymentRequiredBody("https://base.mapleai.shop", flags) as Record<string, never>;
  assert.equal(body.error, "Payment required");
  assert.equal(body.pricing_transparency, "https://base.mapleai.shop/v1/models");
  assert.equal(body.docs, "https://base.mapleai.shop/developers");
  assert.match(body.agent_starter, /veenrek\/mapleai-agent-starter/);
  assert.equal(body.free_trial.embeddings, "https://base.mapleai.shop/v1/embeddings");
  assert.equal(body.free_trial.chat, "https://base.mapleai.shop/v1/free/chat/completions");
});

test("free_trial reflects which free tiers are enabled", () => {
  const none = buildPaymentRequiredBody("https://arc.mapleai.shop", { embeddingsEnabled: false, freeGptOssEnabled: false });
  assert.equal("free_trial" in none, false);
  const embeddingsOnly = buildPaymentRequiredBody("https://arc.mapleai.shop", { embeddingsEnabled: true, freeGptOssEnabled: false }) as Record<string, never>;
  assert.equal(embeddingsOnly.free_trial.embeddings, "https://arc.mapleai.shop/v1/embeddings");
  assert.equal("chat" in embeddingsOnly.free_trial, false);
});

test("extensions from the payment-required header are mirrored into the body", () => {
  const header = Buffer.from(JSON.stringify({
    x402Version: 2,
    extensions: { quote: { price: "$0.001", model: "openai/gpt-6-luna" } },
  })).toString("base64");
  const body = buildPaymentRequiredBody("https://x", flags, header) as Record<string, never>;
  assert.equal(body.extensions.quote.price, "$0.001");
});

test("a malformed payment-required header does not break the body", () => {
  const body = buildPaymentRequiredBody("https://x", flags, "not-base64!!");
  assert.equal("extensions" in body, false);
  assert.equal(body.error, "Payment required");
});

function fakeRes(statusCode: number) {
  const res = {
    statusCode,
    sent: undefined as unknown,
    getHeader: () => undefined,
    json(body: unknown) { res.sent = body; return res; },
  };
  return res;
}

test("middleware enriches only empty 402 bodies", () => {
  const mw = paymentRequiredBodyMiddleware(flags, () => "https://base.mapleai.shop");

  const challenged = fakeRes(402);
  let nextCalled = false;
  mw({} as never, challenged as never, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  challenged.json({});
  assert.equal((challenged.sent as Record<string, never>).pricing_transparency, "https://base.mapleai.shop/v1/models");

  const passedThrough = fakeRes(402);
  mw({} as never, passedThrough as never, () => undefined);
  passedThrough.json({ custom: "body" });
  assert.deepEqual(passedThrough.sent, { custom: "body" });

  const ok = fakeRes(200);
  mw({} as never, ok as never, () => undefined);
  ok.json({});
  assert.deepEqual(ok.sent, {});
});
