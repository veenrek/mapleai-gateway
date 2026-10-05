import test from "node:test";
import assert from "node:assert/strict";

const { shouldBypassPrepaid } = await import("../src/prepaid-bypass.ts");

function fakeReq(method: string, path: string, authorization?: string) {
  return {
    method,
    path,
    get(name: string) {
      return name.toLowerCase() === "authorization" ? authorization : undefined;
    },
  };
}

test("prepaid buyer key on POST /api/v1/* bypasses the paywall", () => {
  assert.ok(shouldBypassPrepaid(fakeReq("POST", "/api/v1/chat/completions", "Bearer oms_buy_Abc123")));
  assert.ok(shouldBypassPrepaid(fakeReq("POST", "/api/v1/responses", "bearer oms_buy_Abc123")));
});

test("no bearer key means x402 flow", () => {
  assert.ok(!shouldBypassPrepaid(fakeReq("POST", "/api/v1/chat/completions")));
  assert.ok(!shouldBypassPrepaid(fakeReq("POST", "/api/v1/chat/completions", "Bearer sk-other-key")));
});

test("only POST /api/v1/ is eligible", () => {
  assert.ok(!shouldBypassPrepaid(fakeReq("GET", "/api/v1/models", "Bearer oms_buy_Abc123")));
  assert.ok(!shouldBypassPrepaid(fakeReq("POST", "/v1/chat/completions", "Bearer oms_buy_Abc123")));
});

test("dedicated POST /prepaid/v1/* endpoint bypasses with a buyer key", () => {
  assert.ok(shouldBypassPrepaid(fakeReq("POST", "/prepaid/v1/chat/completions", "Bearer oms_buy_Abc123")));
  assert.ok(shouldBypassPrepaid(fakeReq("POST", "/prepaid/v1/responses", "bearer oms_buy_Abc123")));
});

test("POST /prepaid/v1/* without a buyer key is answered 401 by the middleware, not bypassed", () => {
  assert.ok(!shouldBypassPrepaid(fakeReq("POST", "/prepaid/v1/chat/completions")));
  assert.ok(!shouldBypassPrepaid(fakeReq("POST", "/prepaid/v1/chat/completions", "Bearer sk-other-key")));
});

test("GET /prepaid/status forwards with any credentials", () => {
  assert.ok(shouldBypassPrepaid(fakeReq("GET", "/prepaid/status", "Bearer oms_buy_Abc123")));
  // Missing/unknown bearer: the admin API answers 401 itself.
  assert.ok(shouldBypassPrepaid(fakeReq("GET", "/prepaid/status")));
});

test("GET /prepaid/status is exact-path and read-only", () => {
  assert.ok(!shouldBypassPrepaid(fakeReq("POST", "/prepaid/status", "Bearer oms_buy_Abc123")));
  assert.ok(!shouldBypassPrepaid(fakeReq("GET", "/prepaid/status/extra", "Bearer oms_buy_Abc123")));
  assert.ok(!shouldBypassPrepaid(fakeReq("GET", "/prepaid/v1/models", "Bearer oms_buy_Abc123")));
});
