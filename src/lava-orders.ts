/**
 * Card-pack order journal for the Lava.top checkout on mapleai.shop.
 *
 * One JSONL file (LAVA_ORDERS_FILE, default ./lava-payments.jsonl) appends every
 * state transition; the in-memory map is rebuilt lazily from the file so the
 * gateway can restart without losing the contractId -> {model, tokens, email}
 * mapping (Lava invoices carry no free-form metadata). Idempotency lives here:
 * the prepaid key is minted once per order and the buyer email is sent once per
 * order; duplicate webhooks are answered 200 without side effects.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

export type LavaOrderStatus = "created" | "paid" | "failed";

export interface LavaOrder {
  order: string; // ML-XXXXXX
  ts: string;
  invoiceId: string;
  contractId?: string;
  email: string;
  model: string;
  tokens: number;
  amountUsd: number;
  status: LavaOrderStatus;
  code?: string;
  emailSent?: boolean;
}

export type LavaOrderEvent = LavaOrder & { at: string; note?: string };

const ordersFile = process.env.LAVA_ORDERS_FILE ?? "./lava-payments.jsonl";

let cache: Map<string, LavaOrder> | undefined;
let byContract = new Map<string, string>();
let byInvoice = new Map<string, string>();
let loaded = false;

function load(): Map<string, LavaOrder> {
  if (loaded) return cache as Map<string, LavaOrder>;
  loaded = true;
  const map = new Map<string, LavaOrder>();
  byContract = new Map();
  try {
    if (existsSync(ordersFile)) {
      for (const line of readFileSync(ordersFile, "utf8").split("\n")) {
        if (line.trim() === "") continue;
        try {
          const event = JSON.parse(line) as LavaOrderEvent;
          if (typeof event.order !== "string") continue;
          const current: LavaOrder = {
            order: event.order,
            ts: event.ts,
            invoiceId: event.invoiceId,
            contractId: event.contractId ?? undefined,
            email: event.email,
            model: event.model,
            tokens: event.tokens,
            amountUsd: event.amountUsd,
            status: event.status,
            code: event.code ?? undefined,
            emailSent: event.emailSent ?? undefined,
          };
          map.set(event.order, current);
          if (current.contractId) byContract.set(current.contractId, current.order);
          if (current.invoiceId) byInvoice.set(current.invoiceId, current.order);
        } catch { /* torn tail line — ignore */ }
      }
    }
  } catch (error) {
    console.error("[lava-orders] journal read failed:", error);
  }
  cache = map;
  return map;
}

/** Human-readable order number: ML- + 6 chars from an unambiguous alphabet. */
function newOrderNumber(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    let candidate = "";
    while (candidate.length < 6) {
      candidate += alphabet[randomBytes(1)[0] % alphabet.length];
    }
    if (!load().has(`ML-${candidate}`)) return `ML-${candidate}`;
  }
  return `ML-${Date.now().toString(36).toUpperCase().slice(-6)}`;
}

function append(event: LavaOrderEvent): void {
  try {
    mkdirSync(dirname(ordersFile) || ".", { recursive: true });
    appendFileSync(ordersFile, JSON.stringify(event) + "\n", { mode: 0o600 });
  } catch (error) {
    console.error("[lava-orders] write failed:", error);
  }
}

export function findLavaOrder(order: string): LavaOrder | undefined {
  return load().get(order);
}

export function findLavaOrderByContract(contractId: string): LavaOrder | undefined {
  load();
  const order = byContract.get(contractId);
  return order ? load().get(order) : undefined;
}

export function findLavaOrderByInvoice(invoiceId: string): LavaOrder | undefined {
  load();
  const order = byInvoice.get(invoiceId);
  return order ? load().get(order) : undefined;
}

/** Persist a fresh order (status created). */
export function createLavaOrder(init: Omit<LavaOrder, "order" | "ts" | "status">): LavaOrder {
  const order: LavaOrder = { ...init, order: newOrderNumber(), ts: new Date().toISOString(), status: "created" };
  load().set(order.order, order);
  if (order.contractId) byContract.set(order.contractId, order.order);
  if (order.invoiceId) byInvoice.set(order.invoiceId, order.order);
  append({ ...order, at: new Date().toISOString(), note: "created" });
  return order;
}

/** Attach the Lava invoice id after invoice creation (webhooks carry it). */
export function attachLavaInvoiceId(order: string, invoiceId: string): LavaOrder | undefined {
  const updated = updateLavaOrder(order, { invoiceId }, "invoice_attached:" + invoiceId);
  if (updated) byInvoice.set(invoiceId, order);
  return updated;
}

/** Merge a state transition into the order; returns the updated snapshot. */
export function updateLavaOrder(
  order: string,
  patch: Partial<Pick<LavaOrder, "status" | "contractId" | "code" | "emailSent" | "invoiceId">>,
  note: string,
): LavaOrder | undefined {
  const current = load().get(order);
  if (!current) return undefined;
  const next: LavaOrder = {
    ...current,
    ...patch,
    invoiceId: patch.invoiceId ?? current.invoiceId,
    contractId: patch.contractId ?? current.contractId,
    code: patch.code ?? current.code,
    emailSent: patch.emailSent ?? current.emailSent,
  };
  load().set(order, next);
  if (next.contractId) byContract.set(next.contractId, order);
  if (next.invoiceId) byInvoice.set(next.invoiceId, order);
  append({ ...next, at: new Date().toISOString(), note });
  return next;
}
