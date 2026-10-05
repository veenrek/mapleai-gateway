import test from "node:test";
import assert from "node:assert/strict";
import type { NextFunction, Request, Response } from "express";

const {
  prepaidCodeModels,
  prepaidModelOffers,
  prepaidStatusUrl,
  validatePrepaidCodePurchase,
} = await import("../src/prepaid-codes.ts");

function invokeValidator(body: unknown) {
  const state: { status: number; response: unknown; nextCalled: boolean } = {
    status: 200,
    response: null,
    nextCalled: false,
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
  };
  validatePrepaidCodePurchase(
    { body } as unknown as Request,
    res as unknown as Response,
    (() => { state.nextCalled = true; }) as NextFunction,
  );
  return state;
}

interface ErrorBody {
  error?: { code?: string; details?: Record<string, unknown> };
}

test("offers derive pack prices from the live input rates", () => {
  const offers = prepaidModelOffers();
  assert.equal(offers.length, prepaidCodeModels.length);
  for (const offer of offers) {
    assert.ok(offer.inputUsdPerMillion > 0, `${offer.model} needs a positive input rate`);
    assert.deepEqual(offer.packPricesUsd.map((p) => p.tokens), [100_000, 1_000_000]);
    const [small, big] = offer.packPricesUsd;
    assert.ok(Math.abs(big.usd - small.usd * 10) < 1e-9);
  }
});

test("invalid model answers with availableModels and a recovery hint", () => {
  const state = invokeValidator({ model: "openai/gpt-9", tokens: 100_000 });
  assert.equal(state.status, 400);
  const err = (state.response as ErrorBody).error;
  assert.equal(err?.code, "invalid_model");
  const details = err?.details ?? {};
  const available = details.availableModels as { model: string }[];
  assert.deepEqual(available.map((m) => m.model), [...prepaidCodeModels]);
  assert.ok(String(details.hint).includes(prepaidStatusUrl));
  assert.ok(!state.nextCalled);
});

test("odd token amounts answer with the allowed steps and a hint", () => {
  const state = invokeValidator({ model: prepaidCodeModels[0], tokens: 150_000 });
  assert.equal(state.status, 400);
  const err = (state.response as ErrorBody).error;
  assert.equal(err?.code, "invalid_token_amount");
  assert.deepEqual(err?.details?.allowedSteps, { min: 100_000, max: 1_000_000, step: 100_000 });
  assert.ok(String(err?.details?.hint).includes("100000"));
  assert.ok(!state.nextCalled);
});

test("a valid purchase body passes validation", () => {
  const state = invokeValidator({ model: prepaidCodeModels[0], tokens: 500_000 });
  assert.ok(state.nextCalled);
});
