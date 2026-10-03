import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { base58 } from "@scure/base";
import { config } from "./config.js";
import { isTokenPriced, pricingForModel } from "./models.js";

export interface UsageRecord {
  ts: string;
  model?: string;
  payer?: string;
  upstreamStatus: number;
  quotedUsd?: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  /** What the request actually cost at our per-token rates (revenue calibration) */
  actualCostUsd?: number;
}

const TOKEN_PROGRAM_IDS = new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
]);
const TOKEN_PROGRAM_BYTES = [...TOKEN_PROGRAM_IDS].map((id) => base58.decode(id));
const IX_TOKEN_TRANSFER = 3;
const IX_TOKEN_TRANSFER_CHECKED = 12;

function readCompactU16(bytes: Buffer, state: { offset: number }): number {
  let value = 0;
  let shift = 0;
  for (;;) {
    const b = bytes[state.offset++];
    value |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 21) throw new Error("compact-u16 overflow");
  }
  return value;
}

/**
 * Buyer address from a Solana wire transaction: the authority (owner) of the
 * token transfer in it. The facilitator holds the fee-payer slot (header index
 * 0), so payer ≠ keys[0] — walk the instructions instead. Falls back to the
 * first non-fee-payer signer when no transfer instruction parses.
 */
export function extractSvmPayer(transactionBase64: string): string | undefined {
  try {
    const bytes = Buffer.from(transactionBase64, "base64");
    const state = { offset: 0 };
    const signatureCount = readCompactU16(bytes, state);
    state.offset += 64 * signatureCount;
    if (bytes[state.offset] === 0x80) state.offset += 1; // versioned (v0) marker
    const requiredSigners = bytes[state.offset];
    state.offset += 3; // header
    const staticKeyCount = readCompactU16(bytes, state);
    if (staticKeyCount < 1 || staticKeyCount > 64) return undefined;
    const keys: Buffer[] = [];
    for (let i = 0; i < staticKeyCount; i++) {
      keys.push(bytes.subarray(state.offset + i * 32, state.offset + (i + 1) * 32));
    }
    state.offset += 32 * staticKeyCount + 32; // keys + recent blockhash
    const instructionCount = readCompactU16(bytes, state);
    for (let i = 0; i < instructionCount; i++) {
      const programIndex = bytes[state.offset++];
      const accountCount = readCompactU16(bytes, state);
      const accounts = [...bytes.subarray(state.offset, state.offset + accountCount)];
      state.offset += accountCount;
      const dataLength = readCompactU16(bytes, state);
      const data = bytes.subarray(state.offset, state.offset + dataLength);
      state.offset += dataLength;
      const program = keys[programIndex];
      if (!program || !TOKEN_PROGRAM_BYTES.some((id) => program.equals(id))) continue;
      if (data[0] === IX_TOKEN_TRANSFER_CHECKED && accounts.length >= 4) {
        const authority = keys[accounts[3]];
        if (authority) return base58.encode(authority);
      }
      if (data[0] === IX_TOKEN_TRANSFER && accounts.length >= 3) {
        const authority = keys[accounts[2]];
        if (authority) return base58.encode(authority);
      }
    }
    // Fallback: first signer that is not the fee payer.
    if (requiredSigners >= 2 && keys[1]) return base58.encode(keys[1]);
    return undefined;
  } catch {
    return undefined;
  }
}

/** Best-effort payer extraction from the x402 payment header (EVM and SVM exact). */
export function extractPayer(paymentHeader: string | undefined): string | undefined {
  if (!paymentHeader) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(paymentHeader, "base64").toString("utf8"));
    const evm = payload?.payload?.authorization?.from ?? payload?.payload?.from;
    if (evm) return evm;
    const transaction = payload?.payload?.transaction;
    if (typeof transaction === "string") return extractSvmPayer(transaction);
    return undefined;
  } catch {
    return undefined;
  }
}

/** Parse OpenAI-style usage from an upstream chat completion body. */
export function parseUsage(body: Buffer): UsageRecord["usage"] | undefined {
  try {
    const json = JSON.parse(body.toString("utf8"));
    const u = json?.usage;
    if (!u) return undefined;
    return {
      promptTokens: u.prompt_tokens,
      completionTokens: u.completion_tokens,
      totalTokens: u.total_tokens,
    };
  } catch {
    return undefined; // streaming / non-JSON upstream response
  }
}

/**
 * Parse usage from an SSE stream tail. The provider emits a final
 * `data: {...}` chunk carrying `usage` before `data: [DONE]` when the client
 * sets `stream_options.include_usage`. The captured tail may start mid-JSON,
 * so scan backwards and keep the last line that parses.
 */
export function parseUsageFromSse(text: string): UsageRecord["usage"] | undefined {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const u = JSON.parse(payload)?.usage;
      if (u) {
        return {
          promptTokens: u.prompt_tokens,
          completionTokens: u.completion_tokens,
          totalTokens: u.total_tokens,
        };
      }
    } catch {
      // partial JSON at the start of the tail window
    }
  }
  return undefined;
}

export function actualCostUsd(model: string | undefined, usage: UsageRecord["usage"]): number | undefined {
  if (!usage || model === undefined) return undefined;
  const pricing = pricingForModel(model);
  if (!pricing || !isTokenPriced(pricing)) return undefined;
  const input = usage.promptTokens ?? 0;
  const output = usage.completionTokens ?? 0;
  return (input * pricing.input + output * pricing.output) / 1_000_000;
}

export function recordUsage(record: UsageRecord): void {
  try {
    const file = config.ledgerFile;
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(record) + "\n");
  } catch (error) {
    console.error("[ledger] failed to write:", error);
  }
}
