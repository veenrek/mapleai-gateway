import test from "node:test";
import assert from "node:assert/strict";

// Regression for the agentkit 402-echo bug (PayAPI report): the World AgentKit
// extension mints a fresh nonce/issuedAt into EVERY 402 challenge, and the x402
// HTTP wrapper regenerates the challenge (new nonce) when the client retries
// with a signed payment. The echo validator compares client-echoed extension
// info against the regenerated challenge's info, so without declaring those
// fields dynamic every valid payment failed with `extension_echo_mismatch`.
// The fix is the same pattern the library's own SIWX and offer-receipt
// extensions use: declare the per-challenge fields via `dynamicInfoFields` on
// the registered extension (src/index.ts, World AgentKit registration).
const { x402ResourceServer } = await import("@x402/express");
const { agentkitResourceServerExtension } = await import("@worldcoin/agentkit");

type AgentkitExt = typeof agentkitResourceServerExtension & { dynamicInfoFields?: string[] };

const RESOURCE_URL = "https://base.mapleai.shop/v1/chat/completions";
const challengeContext = {
  resourceInfo: { url: RESOURCE_URL },
  requirements: [{ network: "eip155:8453" }],
} as never;

/**
 * Model the retry handshake: enricher #1 is the challenge the client saw and
 * echoed into its signed payload, enricher #2 is the freshly regenerated
 * challenge the server builds while verifying that payment.
 */
async function echoVerdict(ext: AgentkitExt) {
  const server = new x402ResourceServer();
  server.registerExtension(ext as never);
  const firstChallenge = await ext.enrichPaymentRequiredResponse(ext as never, challengeContext);
  const regenerated = await ext.enrichPaymentRequiredResponse(ext as never, challengeContext);
  const paymentRequired = { x402Version: 2, accepts: [], extensions: { [ext.key]: regenerated } };
  const echoedPayload = { x402Version: 2, extensions: { [ext.key]: firstChallenge } };
  return server.validateExtensions(paymentRequired as never, echoedPayload as never);
}

test("agentkit nonce/issuedAt marked dynamic: echo of the first challenge passes on retry", async () => {
  const verdict = await echoVerdict({
    ...agentkitResourceServerExtension,
    dynamicInfoFields: ["nonce", "issuedAt", "expirationTime"],
  });
  assert.equal(verdict.valid, true, `expected echo to validate, got ${JSON.stringify(verdict)}`);
});

test("without dynamicInfoFields the same payment is rejected with extension_echo_mismatch", async () => {
  const verdict = await echoVerdict({ ...agentkitResourceServerExtension });
  assert.equal(verdict.valid, false, "echo of a stale nonce must not validate without dynamicInfoFields");
  assert.equal((verdict as { invalidReason?: string }).invalidReason, "extension_echo_mismatch");
  assert.equal((verdict as { extensionKey?: string }).extensionKey, "agentkit");
});

test("the two challenges really do carry different nonces (precondition)", async () => {
  const first = await agentkitResourceServerExtension.enrichPaymentRequiredResponse(
    agentkitResourceServerExtension as never,
    challengeContext,
  );
  const second = await agentkitResourceServerExtension.enrichPaymentRequiredResponse(
    agentkitResourceServerExtension as never,
    challengeContext,
  );
  const info1 = (first as { info: { nonce: string; issuedAt: string } }).info;
  const info2 = (second as { info: { nonce: string; issuedAt: string } }).info;
  assert.notEqual(info1.nonce, info2.nonce, "every 402 enrichment mints a fresh nonce");
  assert.match(info1.issuedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(info2.issuedAt, /^\d{4}-\d{2}-\d{2}T/);
});
