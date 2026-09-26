import { appendFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, decodePaymentSignatureHeader } from '@x402/core/http';
import { config } from './config.js';
import { chainInfo } from './chain.js';

export type PaymentEvent = {
  id: string;
  ts: string;
  kind: 'settled' | 'payment_challenge' | 'payment_rejected' | 'request_failed' | 'settlement_unconfirmed';
  route: string;
  model?: string;
  network: string;
  httpStatus: number;
  payer?: string;
  amountAtomic?: string;
  amountUsdc?: string;
  transaction?: string;
  reason?: string;
};

const paidPaths = new Set(['/v1/chat/completions', '/api/v1/chat/completions', '/v1/responses', '/api/v1/responses',
  '/api/v1/images/generations', '/api/v1/images/image2image', '/jev']);
const eventsFile = process.env.PAYMENT_EVENTS_FILE ?? './payment-events.jsonl';

function clean(value: unknown, max = 160): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value.slice(0, max).split(String.fromCharCode(10)).join(' ').split(String.fromCharCode(13)).join(' ');
}

function usdc(amount: string): string {
  const atomic = BigInt(amount);
  return (atomic / 1_000_000n).toString() + '.' + (atomic % 1_000_000n).toString().padStart(6, '0');
}

function signedInfo(value: string | undefined) {
  if (!value) return undefined;
  try {
    const payment = decodePaymentSignatureHeader(value);
    const accepted = payment.accepted;
    const wallet = payment.payload?.authorization as { from?: unknown } | undefined;
    const payer = clean(wallet?.from ?? payment.payload?.from ?? payment.payload?.payer, 80);
    const asset = chainInfo(config.network, config.paymentAssetAddress).assetAddress;
    if (accepted?.scheme !== 'exact' || accepted?.network !== config.network || accepted?.asset?.toLowerCase() !== asset.toLowerCase() ||
        accepted?.payTo?.toLowerCase() !== config.payTo.toLowerCase() || !/^[0-9]+$/.test(accepted?.amount ?? '')) {
      return { payer };
    }
    return { payer, amountAtomic: accepted.amount, amountUsdc: usdc(accepted.amount) };
  } catch { return undefined; }
}

export function paymentEventForResponse(req: Request, res: Response, id: string): PaymentEvent | undefined {
  const signature = req.get('payment-signature') ?? req.get('x-payment') ?? undefined;
  const signed = signedInfo(signature);
  const event: PaymentEvent = {
    id, ts: new Date().toISOString(), kind: 'request_failed', route: req.path,
    model: clean(req.body?.model, 100), network: config.network, httpStatus: res.statusCode, ...signed,
  };
  const receiptHeader = res.getHeader('payment-response');
  if (typeof receiptHeader === 'string') {
    try {
      const receipt = decodePaymentResponseHeader(receiptHeader);
      if (receipt.success && receipt.network === config.network && res.statusCode < 400 && signed?.amountAtomic && receipt.transaction) {
        const amount = receipt.amount ?? signed.amountAtomic;
        if (/^[0-9]+$/.test(amount)) {
          return { ...event, kind: 'settled', payer: clean(receipt.payer, 80) ?? signed.payer,
            amountAtomic: amount, amountUsdc: usdc(amount),
            transaction: clean(receipt.transaction, 100) };
        }
      }
      event.reason = clean(receipt.errorReason ?? receipt.errorMessage) ?? 'settlement_response_unconfirmed';
    } catch { event.reason = 'invalid_settlement_response'; }
    return { ...event, kind: 'settlement_unconfirmed' };
  }
  if (res.statusCode === 402) {
    let reason: string | undefined;
    const challenge = res.getHeader('payment-required');
    if (typeof challenge === 'string') {
      try { reason = clean(decodePaymentRequiredHeader(challenge).error); } catch { /* malformed challenge */ }
    }
    return { ...event, kind: signature ? 'payment_rejected' : 'payment_challenge',
      reason: reason ?? (signature ? 'payment_not_accepted' : 'payment_required') };
  }
  if (res.statusCode >= 400) return { ...event, reason: 'http_' + res.statusCode };
  if (signature) return { ...event, kind: 'settlement_unconfirmed', reason: 'missing_payment_response' };
  return undefined;
}

export function paymentEventMiddleware(req: Request, res: Response, next: NextFunction): void {
  const nftRequest = req.method === 'GET' && /^\/api\/v1\/[^/]+\/nft\/getNFTMetadata$/.test(req.path);
  if (!nftRequest && (req.method !== 'POST' || !paidPaths.has(req.path))) return next();
  const id = randomUUID();
  res.once('finish', () => {
    const event = paymentEventForResponse(req, res, id);
    if (!event) return;
    try {
      mkdirSync(dirname(eventsFile), { recursive: true });
      appendFileSync(eventsFile, JSON.stringify(event) + String.fromCharCode(10), { mode: 0o600 });
    }
    catch (error) { console.error('[payment-events] write failed:', error); }
  });
  next();
}
