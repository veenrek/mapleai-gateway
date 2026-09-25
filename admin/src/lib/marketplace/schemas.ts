import { z } from "zod";

export const createSellerSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().optional().nullable(),
  payoutDetails: z.unknown().optional(),
});

export const attachConnectionSchema = z.object({
  connectionId: z.string().trim().min(1).max(200),
  accountGroup: z.string().trim().min(1).max(120).optional(),
});

export const createListingSchema = z.object({
  connectionId: z.string().trim().min(1).max(200),
  upstreamModel: z.string().trim().max(300).optional(),
  publicModel: z.string().trim().min(1).max(400).optional().nullable(),
  inputPriceUsdPerMillionTokens: z.number().finite().min(0),
  outputPriceUsdPerMillionTokens: z.number().finite().min(0),
  platformFeeBps: z.number().int().min(0).max(10000).optional(),
  maxRequestsPerMinute: z.number().int().positive().optional().nullable(),
  maxDailyTokens: z.number().int().positive().optional().nullable(),
  /** Route through an omniroute combo: requests use the combo engine. */
  comboId: z.string().trim().min(1).max(200).optional().nullable(),
});

export const createSellerProviderConnectionSchema = z.object({
  provider: z.string().trim().min(1).max(200),
  apiKey: z.string().trim().min(1).max(4000),
  name: z.string().trim().min(1).max(120).optional(),
  defaultModel: z.string().trim().min(1).max(300).optional().nullable(),
  providerSpecificData: z.record(z.string(), z.unknown()).optional().nullable(),
  accountGroup: z.string().trim().min(1).max(120).optional(),
  // Custom OpenAI/Anthropic-compatible endpoint. Must be a public HTTPS URL;
  // validated against the SSRF guard in the route before use.
  baseUrl: z.string().trim().url("baseUrl must be a valid URL").max(500).optional().nullable(),
});

export const updateSellerConnectionSchema = z.object({
  accountGroup: z.string().trim().min(1).max(120),
});

export const createBuyerKeySchema = z.object({
  name: z.string().trim().min(1).max(120),
  balanceUsd: z.number().finite().min(0).optional(),
  allowedModels: z.array(z.string().trim().min(1).max(400)).optional(),
});

export const topUpBuyerKeySchema = z.object({
  amountUsd: z.number().finite().positive(),
  metadata: z.unknown().optional(),
});

const evmAddressSchema = z
  .string()
  .trim()
  .regex(/^0x[0-9a-fA-F]{40}$/, "Invalid EVM wallet address");

export const authNonceSchema = z.object({
  wallet: evmAddressSchema,
});

export const authVerifySchema = z.object({
  wallet: evmAddressSchema,
  signature: z
    .string()
    .trim()
    .regex(/^0x[0-9a-fA-F]{130}$/, "Invalid signature"),
  nonce: z.string().trim().min(8).max(128),
  issuedAt: z.string().trim().min(1).max(64),
});

export const depositAddressSchema = z.object({
  chainId: z.number().int().positive(),
});

export const fundBuyerKeyFromWalletSchema = z.object({
  buyerKeyId: z.string().trim().min(1).max(200),
  amountUsd: z.number().finite().positive(),
});

export const withdrawSchema = z.object({
  chainId: z.number().int().positive(),
  amountUsd: z.number().finite().positive(),
});
