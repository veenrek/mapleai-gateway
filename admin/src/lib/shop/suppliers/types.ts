/**
 * Shared types for digital-goods suppliers (ported from tgshop bot).
 * Each client exposes: enabled(), getBalance(), getCatalog(), purchase(), extractDelivery().
 */

export interface SupplierItem {
  id: string;
  name: string;
  /** purchase price in USD (converted for VND-based suppliers) */
  priceUsd: number | null;
  stock: number | null;
  inStock?: boolean;
  description?: string | null;
}

export interface SupplierPurchaseResult {
  /** supplier-side order/purchase id */
  id: string | number | null;
  /** raw payload — extractDelivery() turns it into customer-facing text */
  [key: string]: unknown;
}

export interface SupplierClient {
  name: string;
  label: string;
  enabled(): boolean;
  getBalance(): Promise<{ balanceUsd: number }>;
  getCatalog(): Promise<{ items: SupplierItem[] }>;
  purchase(input: { itemId: string; idempotencyKey: string }): Promise<SupplierPurchaseResult>;
  /** Extract the deliverable text (code / account / link) from a purchase payload. */
  extractDelivery(payload: unknown): string | null;
}
