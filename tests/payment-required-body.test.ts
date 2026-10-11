import test from "node:test";
import assert from "node:assert/strict";

const { buildPaymentRequiredBody, buildMppChallenges, paymentRequiredBodyMiddleware } =
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

const mppHeader = Buffer.from(JSON.stringify({
  x402Version: 2,
  accepts: [
    { network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0x63db6eaf635a31bbc6714fe37bdc85243864f611", amount: "1000", extra: { description: "chat call" } },
    { network: "eip155:137", asset: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", payTo: "0x63db6eaf635a31bbc6714fe37bdc85243864f611", amount: "1000" },
    { network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", payTo: "9DbpH2Mf9D26ak4bASsv6KA4Ra4V571oLpiVdZjAjcU8", amount: "1000" },
  ],
})).toString("base64");

test("MPP challenges mirror EVM accepts and skip Solana", () => {
  const challenges = buildMppChallenges(mppHeader, "base.mapleai.shop", "test-secret");
  assert.equal(challenges.length, 2);
  for (const challenge of challenges) {
    assert.match(challenge, /^Payment id="[^"]+", realm="base\.mapleai\.shop", method="usdc", intent="charge", expires="\d{4}-\d{2}-\d{2}T/, "params in order");
  }
  const first = /request="([^"]+)"/.exec(challenges[0])![1];
  const requestJson = JSON.parse(Buffer.from(first, "base64url").toString("utf8"));
  assert.equal(requestJson.amount, "1000");
  assert.equal(requestJson.currency, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  assert.equal(requestJson.recipient, "0x63db6eaf635a31bbc6714fe37bdc85243864f611");
  assert.equal(requestJson.description, "chat call");
  assert.deepEqual(requestJson.methodDetails, { chainId: 8453, credentialTypes: ["authorization"] });
  const keys = Object.keys(requestJson);
  assert.deepEqual(keys, [...keys].sort(), "JCS: alphabetical key order");
});

test("MPP challenges survive a malformed header", () => {
  assert.deepEqual(buildMppChallenges("not-base64!!", "x", ""), []);
});

test("middleware sets WWW-Authenticate next to the x402 challenge", () => {
  const res = {
    statusCode: 402,
    sent: undefined as unknown,
    wwwAuth: undefined as unknown,
    getHeader: (name: string) => (name === "payment-required" ? mppHeader : undefined),
    setHeader: (name: string, value: unknown) => { if (name === "WWW-Authenticate") res.wwwAuth = value; },
    json(body: unknown) { res.sent = body; return res; },
  };
  const mw = paymentRequiredBodyMiddleware(flags, () => "https://base.mapleai.shop", "test-secret");
  mw({} as never, res as never, () => undefined);
  res.json({});
  assert.ok(Array.isArray(res.wwwAuth), "two EVM accepts -> header array");
  assert.equal((res.wwwAuth as string[]).length, 2);
});
