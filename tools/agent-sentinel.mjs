#!/usr/bin/env node
// MapleAI agent sentinel: walks the agent funnel hourly, so a broken first
// contact (dead model, wrong 402, 503 after deploy) is caught in minutes
// instead of being reported by a lost customer.
//
// Free checks run against every mirror every invocation; the paid tap loop
// (≈$0.016/day) runs at most once per day against solana + base wallets.
//
// Alerts go to TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID or ALERT_WEBHOOK_URL when
// configured; everything is also logged to stdout for cron.
//
// Usage:
//   SBD_STATE=... --probe-only   skip the paid loop
//   --domains sol,base            limit mirrors (default all)

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import crypto from "node:crypto";
import { createPrivateKey, sign } from "node:crypto";
import path from "node:path";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { registerExactSvmScheme } from "@x402/svm/exact/client";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { base58 } from "@scure/base";
import { privateKeyToAccount } from "viem/accounts";

const DOMAINS = {
  solana: {
    origin: "https://sol.mapleai.shop",
    flag: "sol",
    svm: true,
    network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    payTo: "9DbpH2Mf9D26ak4bASsv6KA4Ra4V571oLpiVdZjAjcU8",
    walletFile: ".secrets/solana-test-wallet.json",
  },
  base: {
    origin: "https://base.mapleai.shop",
    flag: "base",
    network: "eip155:8453",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    payTo: "0x63db6eaf635a31bbc6714fe37bdc85243864f611",
    walletFile: ".secrets/base-buyer-wallet.json",
  },
  polygon: {
    origin: "https://polygon.mapleai.shop",
    flag: "polygon",
    network: "eip155:137",
    asset: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    payTo: "0x63db6eaf635a31bbc6714fe37bdc85243864f611",
  },
  arc: {
    origin: "https://arc.mapleai.shop",
    flag: "arc",
    network: "eip155:5042",
    asset: "0x3600000000000000000000000000000000000000",
    payTo: "0x63db6eaf635a31bbc6714fe37bdc85243864f611",
  },
};

const PROBE_ONLY = process.argv.includes("--probe-only");
const domainsArg = process.argv.find((arg) => arg.startsWith("--domains="));
const activeDomains = domainsArg
  ? domainsArg.split("=")[1].split(",").map((d) => d.trim())
  : Object.keys(DOMAINS);

const failures = [];
const notes = [];

async function probe(name, run) {
  try {
    const detail = await run();
    console.log(`ok   ${name}${detail ? " — " + detail : ""}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`FAIL ${name} — ${message}`);
    if (process.env.SENTINEL_DEBUG && error instanceof Error) console.log(error.stack);
    failures.push(`[${name}] ${message}`);
  }
}

function failureExpect(message) {
  return new Error(message);
}

async function getJson(url, expect = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(expect.timeout ?? 20_000) });
  if (res.status !== 200) throw failureExpect(`expected 200, got ${res.status}`);
  const text = await res.text();
  try { return JSON.parse(text); } catch { throw failureExpect("response is not JSON"); }
}

async function checkChallenge(url, domain, body, amountCapAtoms) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status !== 402) throw failureExpect(`expected 402, got ${res.status}`);
  const raw = res.headers.get("payment-required");
  if (!raw) throw failureExpect("missing PAYMENT-REQUIRED header");
  let challenge;
  try { challenge = JSON.parse(Buffer.from(raw, "base64").toString("utf8")); }
  catch { throw failureExpect("PAYMENT-REQUIRED is not base64 JSON"); }
  if (challenge.x402Version !== 2) throw failureExpect("x402Version is not 2");
  const accept = Array.isArray(challenge.accepts) ? challenge.accepts[0] : undefined;
  if (!accept) throw failureExpect("empty accepts");
  if (accept.scheme !== "exact") throw failureExpect(`scheme=${accept.scheme}`);
  if (accept.network !== domain.network) throw failureExpect(`network=${accept.network}`);
  const same = (a, b) => (domain.svm ? a === b : a?.toLowerCase() === b?.toLowerCase());
  if (!same(accept.asset, domain.asset)) throw failureExpect(`asset=${accept.asset}`);
  if (!same(accept.payTo, domain.payTo)) throw failureExpect(`payTo=${accept.payTo}`);
  const amount = typeof accept.amount === "string" && /^\d+$/.test(accept.amount) ? BigInt(accept.amount) : 0n;
  if (amount < 1n) throw failureExpect("amount is zero");
  if (amount > amountCapAtoms) throw failureExpect(`amount ${accept.amount} exceeds cap ${amountCapAtoms}`);
  return { challenge, amount };
}

async function decodeSettlement(res) {
  const raw = res.headers.get("payment-response");
  if (!raw) return undefined;
  return JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
}

function signAndRetry(challenge, requirement, domain, walletRoot) {
  const walletFile = path.join(walletRoot, domain.walletFile);
  const wallet = JSON.parse(readFileSync(walletFile, "utf8"));
  return (async () => {
    const client = new x402Client().setSpendControls({
      allowedAssets: [{ network: domain.network, asset: domain.asset, maxAmountPerPayment: requirement.amount }],
    });
    if (domain.svm) {
      const key = wallet.privateKeyBase58 ?? wallet.privateKey;
      const signer = await createKeyPairSignerFromBytes(base58.decode(key));
      registerExactSvmScheme(client, { signer, networks: [domain.network] });
    } else {
      const account = privateKeyToAccount(wallet.privateKey);
      registerExactEvmScheme(client, { signer: account, networks: [domain.network] });
    }
    const payment = await client.createPaymentPayload(challenge);
    delete payment.extensions?.quote;
    return Buffer.from(JSON.stringify(payment)).toString("base64");
  })();
}

// Sellable models are read from the live catalogs, so a model DISABLED_MODELS
// pulls (like Luna during the upstream blackout) drops out of the probes and
// returns by itself once the gateway re-enables it.
const FALLBACK_MODELS = [
  "openai/gpt-5.6-sol",
  "openai/gpt-5.6-terra",
  "openai/gpt-6-luna",
  "openai/gpt-6-sol",
];

async function sellableModels(domain) {
  try {
    const res = await fetch(domain.origin + "/v1/models", { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw failureExpect(`catalog HTTP ${res.status}`);
    const catalog = await res.json();
    const models = (catalog.data ?? []).map((m) => m.id).filter((id) => id.startsWith("openai/"));
    return models.length > 0 ? models : FALLBACK_MODELS;
  } catch {
    notes.push(`${domain.flag} catalog read failed, falling back to the static model list`);
    return FALLBACK_MODELS;
  }
}

function tapModelForDay(models) {
  const dayOfYear = Math.floor((Date.now() - Date.UTC(2026, 0, 1)) / 86_400_000);
  return models[dayOfYear % models.length];
}

const USDC_DECIMALS = 6;
const RPC = { solana: "https://api.mainnet-beta.solana.com", base: "https://mainnet.base.org" };

async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw failureExpect(`rpc ${method}: HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw failureExpect(`rpc ${method}: ${body.error.message}`);
  return body.result;
}

async function walletUsdc(domain, walletRoot) {
  const wallet = JSON.parse(readFileSync(path.join(walletRoot, domain.walletFile), "utf8"));
  const address = wallet.address;
  if (domain.svm) {
    const result = await rpc(RPC.solana, "getTokenAccountsByOwner", [address, { mint: domain.asset }, { encoding: "jsonParsed" }]);
    const amount = result?.value?.[0]?.account?.data?.parsed?.info?.tokenAmount?.uiAmountString;
    return Number(amount ?? 0);
  }
  const callData = "0x70a08231" + "0".repeat(24) + address.toLowerCase().replace(/^0x/, "");
  const result = await rpc(RPC.base, "eth_call", [{ to: domain.asset, data: callData }, "latest"]);
  return Number(BigInt(result ?? "0x0")) / 10 ** USDC_DECIMALS;
}

async function paidTap(domain, walletRoot, tapModel) {
  const url = domain.origin + "/prepaid/codes/auto";
  const purchase = JSON.stringify({ model: tapModel, tokens: 100_000 });
  const { challenge, amount } = await checkChallenge(url, domain, { model: tapModel, tokens: 100_000 }, 300_000n);
  const requirement = challenge.accepts[0];
  const signatureHeader = await signAndRetry(challenge, requirement, domain, walletRoot);
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "payment-signature": signatureHeader },
    body: purchase,
    signal: AbortSignal.timeout(120_000),
  });
  const settlement = await decodeSettlement(res);
  const body = await res.json().catch(() => null);
  if (res.status !== 201) throw failureExpect(`expected 201, got ${res.status}: ${JSON.stringify(body)?.slice(0, 120)}`);
  if (settlement && settlement.success !== true) throw failureExpect("settlement failed");
  if (!body?.code || !String(body.code).startsWith("oms_buy_")) throw failureExpect("no oms_buy_ code in tap response");
  if (body.model !== tapModel) throw failureExpect(`tap model: ${body.model}`);
  if (Number(body?.tokens?.total) !== 100_000) throw failureExpect("token budget mismatch");

  const statusRes = await fetch(body.status_url ?? "https://mapleai.shop/v1/prepaid/status", {
    headers: { authorization: "Bearer " + body.code },
    signal: AbortSignal.timeout(20_000),
  });
  const status = await statusRes.json().catch(() => null);
  if (statusRes.status !== 200 || status?.valid !== true) throw failureExpect("issued key failed status check");
  if (Number(status?.tokens?.remaining) !== 100_000) throw failureExpect("remaining mismatch");
  return `settled ${amount} atoms tx=${settlement?.transaction ?? "?"} key+status ok`;
}

async function paidChatSettle(domain, modelId, walletRoot) {
  const url = domain.origin + "/v1/chat/completions";
  const request = JSON.stringify({ model: modelId, messages: [{ role: "user", content: "Reply with OK" }], max_tokens: 4 });
  const { challenge } = await checkChallenge(url, domain, { model: modelId, messages: [{ role: "user", content: "Reply with OK" }], max_tokens: 4 }, 5_000n);
  const requirement = challenge.accepts[0];
  const signatureHeader = await signAndRetry(challenge, requirement, domain, walletRoot);
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "payment-signature": signatureHeader },
    body: request,
    signal: AbortSignal.timeout(120_000),
  });
  const settlement = await decodeSettlement(res);
  const body = await res.text();
  if (res.status !== 200) {
    throw failureExpect(`${modelId}: HTTP ${res.status} ${body.slice(0, 120)} (settlement cancelled, no spend)`);
  }
  if (settlement && settlement.success !== true) throw failureExpect(`${modelId}: settlement failed`);
  const content = JSON.parse(body)?.choices?.[0]?.message?.content ?? "";
  if (typeof content !== "string" || content.length === 0) throw failureExpect(`${modelId}: empty content`);
  return `${modelId} settled`;
}

function stateFile() {
  return process.env.SENTINEL_STATE_FILE ?? "sentinel-state.json";
}
function loadState() {
  try { return JSON.parse(readFileSync(stateFile(), "utf8")); } catch { return {}; }
}
function saveState(state) {
  try {
    mkdirSync(path.dirname(stateFile()), { recursive: true });
  } catch { /* root of cwd */ }
  writeFileSync(stateFile(), JSON.stringify(state));
}

async function alert(message) {
  const text = "MapleAI agent sentinel\n" + message;
  const hook = process.env.ALERT_WEBHOOK_URL;
  if (hook) {
    try {
      await fetch(hook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, failures: failures.length ? failures : undefined }),
        signal: AbortSignal.timeout(10_000),
      });
      notes.push("alert sent to webhook");
    } catch (error) {
      notes.push("webhook delivery failed: " + (error instanceof Error ? error.message : error));
    }
  }
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (token && chatId) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw failureExpect("telegram HTTP " + res.status);
      notes.push("alert sent to telegram");
    } catch (error) {
      notes.push("telegram delivery failed: " + (error instanceof Error ? error.message : error));
    }
  }
}

// ---------------------------------------------------------------------------

for (const flag of activeDomains) {
  const domain = DOMAINS[flag];
  if (!domain) { failures.push(`unknown domain ${flag}`); continue; }

  await probe(`${flag} models`, async () => {
    const catalog = await getJson(domain.origin + "/v1/models");
    const gpt = (catalog.data ?? []).filter((m) => m.id.startsWith("openai/"));
    if (gpt.length !== 4) throw failureExpect(`expected 4 GPT models, got ${gpt.length}`);
    for (const m of gpt) {
      if (!(m.pricing?.input > 0) || !(m.pricing?.output > 0)) throw failureExpect(`bad pricing on ${m.id}`);
    }
    return `${gpt.length} models, cheapest in $${Math.min(...gpt.map((m) => m.pricing.input))}`;
  });

  await probe(`${flag} openapi`, async () => {
    const spec = await getJson(domain.origin + "/openapi.json");
    const paths = Object.keys(spec.paths ?? {});
    if (paths.length < 10) throw failureExpect(`only ${paths.length} paths`);
    const embed = spec.paths["/v1/embeddings"]?.post?.["x-worked-example"];
    if (!embed?.curl) throw failureExpect("missing worked example for embeddings");
    const hasProof = spec["x-agentcash-provenance"]?.ownershipProofs?.length > 0 || spec["x-discovery"]?.ownershipProofs?.length > 0;
    if (!hasProof) throw failureExpect("ownership proofs missing");
    return `${paths.length} paths`;
  });

  await probe(`${flag} agent-card`, async () => {
    const card = await getJson(domain.origin + "/.well-known/agent-card.json");
    if (!Array.isArray(card.skills) || card.skills.length < 6) throw failureExpect(`skills=${card.skills?.length}`);
    return `${card.skills.length} skills`;
  });

  await probe(`${flag} embeddings`, async () => {
    const res = await fetch(domain.origin + "/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "sentinel heartbeat", input_type: "query" }),
      signal: AbortSignal.timeout(60_000),
    });
    if (res.status !== 200) throw failureExpect(`expected 200, got ${res.status}`);
    const body = await res.json();
    const vector = body?.data?.[0]?.embedding;
    if (!Array.isArray(vector) || vector.length !== 2048) throw failureExpect("no 2048-dim vector");
    if (typeof body.hint_next !== "string" || !body.hint_next.includes("/v1/chat/completions")) {
      throw failureExpect("hint_next marker missing");
    }
    return `dim=${vector.length}`;
  });

  await probe(`${flag} chat challenge`, async () => {
    // Polygon's facilitator overhead is ~2.5x base/sol (payai rate card), so its cap is wider.
    const chatCap = flag === "polygon" ? 6_500n : 5_000n;
    const { amount } = await checkChallenge(domain.origin + "/v1/chat/completions", domain,
      { model: "openai/gpt-6-luna", messages: [{ role: "user", content: "OK?" }], max_tokens: 8 }, chatCap);
    return `amount ${amount} atoms`;
  });

  await probe(`${flag} jev challenge`, async () => {
    await checkChallenge(domain.origin + "/jev", domain,
      { model: "jev-latest", state: "Sentinel check state.", questions: { billing: { type: "noul", instructions: "Is this about billing?" } } }, 10_000n);
    return "shape ok";
  });

  await probe(`${flag} tap challenge`, async () => {
    await checkChallenge(domain.origin + "/prepaid/codes/auto", domain, {}, 20_000n);
    return "shape ok";
  });

  await probe(`${flag} free oss chat`, async () => {
    const res = await fetch(domain.origin + "/v1/free/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "Sentinel heartbeat: reply with OK" }], stream: false }),
      signal: AbortSignal.timeout(90_000),
    });
    if (res.status === 429) {
      // Per-agent quota hit — the tier is alive, probes themselves overran it.
      return "429 quota exhausted (tier alive)";
    }
    if (res.status !== 200) throw failureExpect(`expected 200, got ${res.status}`);
    const body = await res.json().catch(() => null);
    if (body?.model !== "nvidia/gpt-oss-20b") throw failureExpect(`model: ${body?.model}`);
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.length === 0) throw failureExpect("empty content");
    if (body?.usage && typeof body.usage.total_tokens !== "number") throw failureExpect("bad usage block");
    const remaining = res.headers.get("x-ratelimit-remaining-day");
    return `content ${content.length} chars, remaining-day ${remaining ?? "?"}`;
  });
}

if (!PROBE_ONLY) {
  const state = loadState();
  const today = new Date().toISOString().slice(0, 10);
  if (state.lastPaidRun !== today) {
    const walletRoot = process.env.SENTINEL_WALLET_ROOT ?? ".";
    // USDC on the test wallets: report balance, warn near exhaustion, and skip
    // only what the balance cannot fund instead of spuriously FAILing the loop.
    const balances = {};
    for (const flag of ["solana", "base"]) {
      if (!activeDomains.includes(flag)) continue;
      await probe(`${flag} wallet usdc`, async () => {
        const usdc = await walletUsdc(DOMAINS[flag], walletRoot);
        balances[flag] = usdc;
        if (usdc < 0.05) notes.push(`${flag} test wallet below $0.05 USDC (${usdc.toFixed(6)}) — refill soon`);
        return `$${usdc.toFixed(4)}`;
      });
    }
    const modelsByFlag = {};
    for (const flag of ["solana", "base"]) {
      if (!activeDomains.includes(flag)) continue;
      modelsByFlag[flag] = await sellableModels(DOMAINS[flag]);
    }
    for (const flag of ["solana", "base"]) {
      if (!activeDomains.includes(flag)) continue;
      const usdc = balances[flag];
      if (usdc === undefined) {
        await probe(`${flag} paid tap (rpc) balance`, () => { throw failureExpect("wallet balance unavailable"); });
        continue;
      }
      const models = modelsByFlag[flag] ?? FALLBACK_MODELS;
      const settleCost = models.length * 0.0011;
      if (usdc < settleCost) {
        notes.push(`${flag} wallet too low for settle checks ($${usdc.toFixed(4)} < $${settleCost.toFixed(4)}) — skipped, refill needed`);
        continue;
      }
      if (usdc < 0.05) {
        notes.push(`${flag} wallet too low for the tap pack ($${usdc.toFixed(4)}) — tap skipped, refill needed`);
      } else {
        const tapModel = process.env.SENTINEL_TAP_MODEL ?? tapModelForDay(models);
        await probe(`${flag} paid tap ${tapModel}`, () => paidTap(DOMAINS[flag], walletRoot, tapModel));
      }
      for (const modelId of models) {
        await probe(`${flag} paid settle ${modelId}`, () => paidChatSettle(DOMAINS[flag], modelId, walletRoot));
      }
    }
    state.lastPaidRun = today;
    saveState(state);
  } else {
    console.log("info paid tap already ran today");
  }
}

// -- Bazaar parity with the x402 leaders (daily, free) --------------------
// The x402scan UI renders whatever the market leaders put in their 402
// bazaar extensions. If a new discovery field becomes common practice and
// ours stays behind, the marketplace card quietly loses features — the same
// miss that hid serviceName/tags/iconUrl until Cluster Protocol showed them.
{
  const bazaarState = loadState();
  const today = new Date().toISOString().slice(0, 10);
  if (bazaarState.lastBazaarRun !== today) {
    const fetchScan = async () => {
      const res = await fetch("https://www.x402scan.com/", { signal: AbortSignal.timeout(25_000) });
      if (res.status !== 200) throw failureExpect(`x402scan homepage ${res.status}`);
      return (await res.text()).replace(/\\"/g, '"');
    };

    await probe("x402scan listing", async () => {
      const res = await fetch(
        "https://www.x402scan.com/api/trpc/public.origins.search?input=" +
          encodeURIComponent('{"json":{"search":"mapleai"}}'),
        { signal: AbortSignal.timeout(25_000) },
      );
      if (res.status !== 200) throw failureExpect(`origins.search ${res.status}`);
      const origins = ((await res.json())?.result?.data?.json ?? []).map((o) => o?.origin ?? "");
      const flags = ["sol", "base", "polygon", "arc"];
      const missing = flags.filter((f) => !origins.includes(`https://${f}.mapleai.shop`));
      if (missing.length === flags.length) {
        throw failureExpect("no mapleai.shop origins on x402scan — check discovery doc or re-register");
      }
      const msg = `${flags.length - missing.length}/${flags.length} origins indexed`;
      if (missing.length > 0) notes.push(`x402scan missing ${missing.join(", ")} — register at https://www.x402scan.com/resources/register`);
      return msg;
    });

    await probe("bazaar parity with x402 leaders", async () => {
      const html = await fetchScan();
      const leaders = new Map();
      const re = /"origins":\[\{"id":"([^"]+)","origin":"(https?:\/\/[^"]+)"/g;
      for (const m of html.matchAll(re)) {
        const [, id, origin] = m;
        if (origin.includes("mapleai.shop")) continue;
        const ctx = html.slice(m.index + m[0].length, m.index + m[0].length + 1500);
        const tx = Number(/"tx_count":(\d+)/.exec(ctx)?.[1] ?? 0);
        const amt = Number(/"total_amount":(\d+)/.exec(ctx)?.[1] ?? 0);
        const prev = leaders.get(origin);
        if (!prev || prev.tx < tx) leaders.set(origin, { id, tx, amt });
      }
      const all = [...leaders.entries()];
      const pick = new Map();
      for (const e of all.sort((a, b) => b[1].tx - a[1].tx).slice(0, 4)) pick.set(e[0], e[1]);
      for (const e of all.sort((a, b) => b[1].amt - a[1].amt).slice(0, 2)) pick.set(e[0], e[1]);
      if (pick.size === 0) throw failureExpect("no leaders parsed from x402scan homepage");

      const leaderKeys = new Set();
      const skipped = [];
      let matched = 0;
      for (const [origin, meta] of [...pick].slice(0, 6)) {
        try {
          const page = await fetch(`https://www.x402scan.com/server/${meta.id}`, { signal: AbortSignal.timeout(25_000) });
          if (page.status !== 200) { skipped.push(`${origin}: scan ${page.status}`); continue; }
          const phtml = (await page.text()).replace(/\\"/g, '"');
          const host = new URL(origin).host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const paths = [...new Set(
            [...phtml.matchAll(new RegExp(host + "(/[A-Za-z0-9/_-]{2,})", "g"))]
              .map((m) => m[1])
              .filter((p) => !/(favicon|icon|robots|sitemap|\.well-known|thumbnail)$/i.test(p)),
          )].sort((a, b) => (/(^\/v1\/|^\/api\/)/.test(b) ? 1 : 0) - (/(^\/v1\/|^\/api\/)/.test(a) ? 1 : 0));
          let got = false;
          for (const path of paths.slice(0, 3)) {
            const chall = await fetch(origin.replace(/\/+$/, "") + path, {
              method: "POST", headers: { "content-type": "application/json" }, body: "{}",
              signal: AbortSignal.timeout(20_000),
            });
            const hdr = chall.headers.get("payment-required");
            // v1 servers put the challenge in the 402 body instead of the header.
            const challenge = hdr
              ? JSON.parse(Buffer.from(hdr, "base64").toString("utf8"))
              : chall.status === 402
                ? await chall.json().catch(() => null)
                : null;
            if (!challenge) continue;
            const bazaar = challenge?.extensions?.bazaar;
            if (!bazaar) { skipped.push(`${origin}: no bazaar ext`); got = true; matched++; break; }
            for (const k of Object.keys(bazaar)) leaderKeys.add(k);
            got = true; matched++;
            break;
          }
          if (!got) skipped.push(`${origin}: no 402 among ${Math.min(paths.length, 3)} paths`);
        } catch (e) { skipped.push(`${origin}: ${e.message}`); }
      }
      if (matched === 0) throw failureExpect(`no leader returned a 402 (${skipped.slice(0, 3).join(" | ") || "none tried"})`);

      const ours = await checkChallenge(
        DOMAINS[activeDomains[0]].origin + "/jev",
        DOMAINS[activeDomains[0]],
        { model: "jev-latest", state: "Sentinel check state.", questions: { billing: { type: "noul", instructions: "Is this about billing?" } } },
        10_000n,
      );
      const ourKeys = new Set(Object.keys(ours.challenge?.extensions?.bazaar ?? {}));
      const missing = [...leaderKeys].filter((k) => !ourKeys.has(k));
      if (missing.length > 0) throw failureExpect(`x402 leaders use bazaar fields we lack: ${missing.join(", ")}`);
      return `${matched}/${pick.size} leaders with 402, keys ${[...leaderKeys].join("/") || "none"}${skipped.length ? ` — skipped: ${skipped.slice(0, 3).join(" | ")}` : ""}`;
    });

    bazaarState.lastBazaarRun = today;
    saveState(bazaarState);
  } else {
    console.log("info bazaar parity already ran today");
  }
}

// -- PayAI facilitator economics (twice daily) -----------------------------
// The payai rate card floats with on-chain gas (refreshed daily, gas+30%),
// and free credits are per-wallet lifetime. Both shocks are silent: reprice
// only in our FACILITATOR_FEE_USD env, and top up before the balance dies.
{
  const payaiState = loadState();
  const now = new Date();
  const bucket = now.toISOString().slice(0, 13) + (now.getUTCHours() < 12 ? "a" : "p");
  if (payaiState.lastPayaiCheck !== bucket) {
    await probe("payai rate card vs our overhead", async () => {
      const res = await fetch("https://facilitator.payai.network/pricing", { signal: AbortSignal.timeout(15_000) });
      if (res.status !== 200) throw failureExpect(`pricing ${res.status}`);
      const table = await res.json();
      const networks = { sol: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", base: "eip155:8453", polygon: "eip155:137" };
      const issues = [];
      const readings = [];
      for (const [flag, network] of Object.entries(networks)) {
        const rates = (table.rates ?? []).filter((r) => r?.network === network && r?.scheme === "exact");
        const values = rates.map((r) => Number(r.usd)).filter(Number.isFinite);
        const theirUsd = values.length > 0 ? Math.max(...values) : NaN;
        if (!Number.isFinite(theirUsd)) continue;
        let ours = NaN;
        try {
          const envText = readFileSync(`/opt/claude-api-${flag}/.env`, "utf8");
          ours = Number(/^FACILITATOR_FEE_USD=(\S+)/m.exec(envText)?.[1]);
        } catch { /* not running on the VDS */ }
        readings.push(`${flag} rate=${theirUsd} ours=${Number.isFinite(ours) ? ours : "?"}`);
        if (Number.isFinite(ours) && ours < theirUsd * 1.05) {
          issues.push(`${flag}: overhead ${ours} < rate ${theirUsd} (+5%) — bump FACILITATOR_FEE_USD`);
        }
      }
      if (readings.length === 0) throw failureExpect("no rates parsed from payai pricing");
      if (issues.length > 0) throw failureExpect(issues.join("; "));
      return readings.join(", ");
    });

    const keyId = process.env.PAYAI_API_KEY_ID;
    const keySecret = process.env.PAYAI_API_KEY_SECRET;
    if (!keyId || !keySecret) {
      notes.push("payai credits balance check inactive — set PAYAI_API_KEY_ID/PAYAI_API_KEY_SECRET in sentinel.env");
    } else {
      await probe("payai credits balance", async () => {
        const der = Buffer.from(keySecret.replace(/^payai_sk_/, ""), "base64");
        const privKey = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
        const b64u = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
        const ts = Math.floor(Date.now() / 1000);
        const jwtData = b64u({ alg: "EdDSA", typ: "JWT", kid: keyId }) + "." +
          b64u({ sub: keyId, iss: "payai-merchant", iat: ts, exp: ts + 120, jti: crypto.randomUUID() });
        const jwt = jwtData + "." + sign(null, Buffer.from(jwtData), privKey).toString("base64url");
        const res = await fetch("https://merchant.payai.network/api/v1/account", {
          headers: { authorization: "Bearer " + jwt }, signal: AbortSignal.timeout(15_000),
        });
        if (res.status !== 200) throw failureExpect(`account ${res.status}`);
        const account = await res.json().catch(() => null);
        const candidates = [account?.credits?.balance, account?.credits?.remaining, account?.creditBalance, account?.balance, account?.credits]
          .map(Number).filter(Number.isFinite);
        if (candidates.length === 0) {
          notes.push(`payai account shape not recognized: ${JSON.stringify(account)?.slice(0, 160)}`);
          return "account ok, balance field unknown";
        }
        const remaining = Math.max(...candidates);
        if (remaining < 1000) throw failureExpect(`payai credits low: ${remaining} — top up at merchant.payai.network`);
        if (remaining < 2500) notes.push(`payai credits ${remaining} — plan a top-up`);
        return `${remaining} credits`;
      });
    }

    payaiState.lastPayaiCheck = bucket;
    saveState(payaiState);
  } else {
    console.log("info payai economics already ran this half-day");
  }
}

const summary = `${activeDomains.length} domains scanned${PROBE_ONLY ? " (probe-only)" : ""}.`;
if (failures.length > 0) {
  await alert(`${failures.length} check(s) failing. ${summary}\n` + failures.slice(0, 8).join("\n"));
}
for (const note of notes) console.log("info", note);
console.log(failures.length ? `FAILURES: ${failures.length}` : "ALL CHECKS PASSED");
process.exit(failures.length ? 1 : 0);
