/**
 * Admin wallet allowlist — wallet-based login for the platform owner.
 *
 * `ADMIN_WALLET_ADDRESSES` (comma-separated EVM addresses). When set, the
 * owner can sign a SIWE message with one of these wallets instead of the
 * management password; the password remains valid as break-glass access.
 * Empty/absent list = wallet login disabled.
 */

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

export function normalizeAdminWallet(address: string | null | undefined): string | null {
  if (typeof address !== "string") return null;
  const trimmed = address.trim();
  if (!ADDRESS_PATTERN.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

export function getAdminWalletAddresses(): string[] {
  const raw = process.env.ADMIN_WALLET_ADDRESSES || "";
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const normalized = normalizeAdminWallet(part);
    if (normalized) seen.add(normalized);
  }
  return [...seen];
}

export function isAdminWalletLoginEnabled(): boolean {
  return getAdminWalletAddresses().length > 0;
}

/** Constant-ish membership check on lowercased hex. */
export function isAdminWallet(address: string | null | undefined): boolean {
  const normalized = normalizeAdminWallet(address);
  if (!normalized) return false;
  return getAdminWalletAddresses().includes(normalized);
}
