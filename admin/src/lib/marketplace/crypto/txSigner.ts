// EVM transaction signing and sending for the marketplace treasury withdrawal
// subsystem. Deliberately kept small: EIP-1559 (type‑2) transactions only,
// ERC‑20 `transfer` calldata, raw JSON-RPC eth_sendRawTransaction.
//
// Private key: read from MARKETPLACE_TREASURY_PRIVKEY env var, passed through
// the existing decrypt() helper (so it can be stored encrypted at rest). The
// decrypted hex key is held only in local scope, never logged, never returned
// in error responses. See src/lib/db/encryption.ts for the encryption format.
import { keccak_256 } from "@noble/hashes/sha3";
import { secp256k1 } from "@noble/curves/secp256k1";
import { publicKeyToAddress } from "./address";
import { decrypt } from "@/lib/db/encryption";

// ── RLP encoding (deliberately hand-rolled — no ethers/web3 dependency) ─────

/** Encode a non-negative integer as RLP (minimal big-endian, zero → empty). */function rlpEncodeInt(n: number | bigint): Uint8Array {
  if (n === 0n || n === 0) return new Uint8Array(0);
  let hex = n.toString(16);
  if (hex.length % 2 !== 0) hex = "0" + hex;
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

/** RLP length prefix for a payload of `len` bytes (single-byte, 2-byte, or 3+ byte header). */
function rlpLengthPrefix(len: number): Uint8Array {
  if (len <= 55) return new Uint8Array([0x80 + len]);
  const lenBytes = rlpEncodeInt(len);
  return new Uint8Array([0xb7 + lenBytes.length, ...lenBytes]);
}

/** RLP-encode a Uint8Array item. */
function rlpEncodeBytes(item: Uint8Array): Uint8Array {
  if (item.length === 1 && item[0] < 0x80) return item;
  return concatBytes(rlpLengthPrefix(item.length), item);
}

/** RLP-encode a list of already-encoded items. */
function rlpEncodeList(items: Uint8Array[]): Uint8Array {
  const payload = concatBytes(...items);
  return concatBytes(
    payload.length <= 55
      ? new Uint8Array([0xc0 + payload.length])
      : concatBytes(new Uint8Array([0xf7 + rlpEncodeInt(payload.length).length]), rlpEncodeInt(payload.length)),
    payload
  );
}

/**
 * RLP-encode a non-negative integer as a list ITEM: a byte string of its minimal
 * big-endian bytes. This is distinct from `rlpEncodeInt`, which returns the bare
 * scalar bytes (no string header) for use inside length prefixes. As a list item
 * an integer MUST be string-framed — e.g. 0 → 0x80 (empty string), and a
 * multi-byte value like 0x3b9aca00 → 0x84 3b9aca00. Passing the bare
 * `rlpEncodeInt` bytes here would emit unframed bytes that run into the next
 * field, producing RLP a node rejects.
 */
function rlpScalar(n: number | bigint): Uint8Array {
  return rlpEncodeBytes(rlpEncodeInt(n));
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

// ── Signing ─────────────────────────────────────────────────────────────────

/** EIP-1559 (type‑2) transaction fields. */
export interface Eip1559Tx {
  chainId: number;
  nonce: number;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  gasLimit: bigint;
  to: string;       // recipient (ERC‑20 token contract)
  value: bigint;    // ETH value (0 for ERC‑20 transfer)
  data: string;     // 0x‑prefixed calldata
}

/**
 * Compute the EIP-1559 type‑2 transaction hash that must be signed:
 * keccak256(0x02 || rlp([chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit, to, value, data, accessList]))
 */
function eip1559TxHash(tx: Eip1559Tx): Uint8Array {
  const encoded = rlpEncodeList([
    rlpScalar(tx.chainId),
    rlpScalar(tx.nonce),
    rlpScalar(tx.maxPriorityFeePerGas),
    rlpScalar(tx.maxFeePerGas),
    rlpScalar(tx.gasLimit),
    rlpEncodeBytes(decodeHex(tx.to)),
    rlpScalar(tx.value),
    rlpEncodeBytes(decodeHex(tx.data)),
    rlpEncodeList([]), // accessList = [] (empty RLP list 0xc0, not empty string 0x80)
  ]);
  const prefixed = concatBytes(new Uint8Array([0x02]), encoded);
  return keccak_256(prefixed);
}

function decodeHex(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  return Uint8Array.from(Buffer.from(clean, "hex"));
}

function encodeHex(bytes: Uint8Array): string {
  return "0x" + Buffer.from(bytes).toString("hex");
}

/**
 * Sign an EIP-1559 transaction and return the RLP-encoded raw transaction
 * (0x‑prefixed hex) ready for eth_sendRawTransaction.
 */
export function signEip1559Tx(tx: Eip1559Tx, privateKeyHex: string): string {
  const priv = decodeHex(privateKeyHex);
  const hash = eip1559TxHash(tx);
  const sig = secp256k1.sign(hash, priv);

  // EIP-1559 encodes v as 0 or 1 (parity), not 27/28.
  const yParity = sig.recovery ? 1 : 0;

  const signed = rlpEncodeList([
    rlpScalar(tx.chainId),
    rlpScalar(tx.nonce),
    rlpScalar(tx.maxPriorityFeePerGas),
    rlpScalar(tx.maxFeePerGas),
    rlpScalar(tx.gasLimit),
    rlpEncodeBytes(decodeHex(tx.to)),
    rlpScalar(tx.value),
    rlpEncodeBytes(decodeHex(tx.data)),
    rlpEncodeList([]), // accessList = [] (empty RLP list 0xc0, not empty string 0x80)
    // (v, r, s) as per EIP-1559: v = yParity (0 → 0x80, 1 → 0x01); r, s are
    // unsigned integers encoded minimally (leading zero bytes stripped), matching
    // go-ethereum's big.Int RLP — a fixed 32-byte string would be non-canonical
    // when r/s has a leading zero byte.
    rlpScalar(yParity),
    rlpScalar(sig.r),
    rlpScalar(sig.s),
  ]);

  return "0x02" + Buffer.from(signed).toString("hex");
}

// ── calldata ────────────────────────────────────────────────────────────────

/**
 * Build the calldata for an ERC‑20 `transfer(address to, uint256 amount)` call.
 *   selector = keccak256("transfer(address,uint256)")[0:4] = 0xa9059cbb
 *   to       = left-padded to 32 bytes
 *   amount   = left-padded to 32 bytes
 */
export function buildTransferCalldata(to: string, amountBaseUnits: string): string {
  const selector = "a9059cbb";
  const toPadded = to.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const amountPadded = BigInt(amountBaseUnits).toString(16).padStart(64, "0");
  return "0x" + selector + toPadded + amountPadded;
}

// ── RPC calls ───────────────────────────────────────────────────────────────

let rpcId = 1;

async function rpcCall<T>(rpcUrl: string, method: string, params: unknown[]): Promise<T> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
  });
  if (!response.ok) {
    throw new Error(`RPC ${method} failed: HTTP ${response.status}`);
  }
  const json = (await response.json()) as { result?: T; error?: { message?: string } };
  if (json.error) {
    throw new Error(`RPC ${method} error: ${json.error.message || "unknown"}`);
  }
  return json.result as T;
}

export async function getTransactionCount(rpcUrl: string, address: string): Promise<number> {
  const hex = await rpcCall<string>(rpcUrl, "eth_getTransactionCount", [address, "pending"]);
  return parseInt(hex, 16);
}

interface FeeEstimate {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/** Fetch fee data following EIP-1559. Falls back gracefully if the node doesn't support it. */
export async function getFeeData(rpcUrl: string): Promise<FeeEstimate> {
  try {
    // eth_maxPriorityFeePerGas returns the suggested tip as a bare hex QUANTITY
    // string (e.g. "0x9502f900"), not an object — read it directly.
    const tipHex = await rpcCall<string>(rpcUrl, "eth_maxPriorityFeePerGas", []);
    // Estimate base fee from the latest block and add a buffer for fluctuation
    // between blocks.
    const priority = BigInt(tipHex || "0x59682f00"); // ~1.5 Gwei fallback

    let baseFee = BigInt("40000000000"); // 40 Gwei fallback
    try {
      const block = await rpcCall<{ baseFeePerGas?: string }>(
        rpcUrl,
        "eth_getBlockByNumber",
        ["latest", false]
      );
      if (block?.baseFeePerGas) baseFee = BigInt(block.baseFeePerGas);
    } catch {
      // keep fallback
    }
    return {
      maxPriorityFeePerGas: priority,
      maxFeePerGas: (baseFee * 110n) / 100n + priority, // baseFee * 1.1 + priority
    };
  } catch {
    return {
      maxPriorityFeePerGas: BigInt("1500000000"),  // 1.5 Gwei
      maxFeePerGas: BigInt("50000000000"),          // 50 Gwei
    };
  }
}

/** Estimate gas for an ERC‑20 transfer. Uses a conservative fallback (80k). */
export async function estimateTransferGas(
  rpcUrl: string,
  from: string,
  to: string,
  data: string
): Promise<bigint> {
  try {
    const hex = await rpcCall<string>(rpcUrl, "eth_estimateGas", [
      { from, to, data },
    ]);
    const est = BigInt(hex);
    // Pad by 20% for safety.
    return (est * 120n) / 100n;
  } catch {
    return 80000n; // conservative fallback
  }
}

// ── Treasury key ────────────────────────────────────────────────────────────

function getTreasuryPrivateKey(): { address: string; hex: string } | null {
  const raw = (process.env.MARKETPLACE_TREASURY_PRIVKEY || "").trim();
  if (!raw) return null;
  const hex = decrypt(raw);
  if (!hex || hex.length !== 64) {
    console.warn("[TxSigner] MARKETPLACE_TREASURY_PRIVKEY is set but key is malformed after decryption");
    return null;
  }
  let address: string;
  try {
    const pub = secp256k1.getPublicKey(hex, false);
    address = publicKeyToAddress(pub).toLowerCase();
  } catch {
    console.warn("[TxSigner] Failed to derive treasury address from private key");
    return null;
  }
  return { address, hex };
}

/** Return the treasury owner address (derived from the configured private key) or null. */
export function getTreasuryAddress(): string | null {
  return getTreasuryPrivateKey()?.address ?? null;
}

/** True when a treasury hot-wallet private key is configured and decrypts. */
export function isTreasuryWithdrawalEnabled(): boolean {
  return getTreasuryPrivateKey() !== null;
}

// ── Send ────────────────────────────────────────────────────────────────────

export interface SendTxResult {
  txHash: string;
}

/**
 * Build, sign, and send an ERC‑20 `transfer` transaction from the treasury
 * wallet to `toAddress`. Returns the transaction hash.
 *
 * Security: the decrypted private key is held only within this function scope;
 * it is never returned, never logged, never serialized.
 */
export async function sendErc20Transfer(params: {
  rpcUrl: string;
  chainId: number;
  tokenAddress: string;
  toAddress: string;
  amountBaseUnits: string;
}): Promise<SendTxResult> {
  const treasury = getTreasuryPrivateKey();
  if (!treasury) throw new Error("Treasury withdrawals are not configured");

  const calldata = buildTransferCalldata(params.toAddress, params.amountBaseUnits);
  const [nonce, fees, gasLimit] = await Promise.all([
    getTransactionCount(params.rpcUrl, treasury.address),
    getFeeData(params.rpcUrl),
    estimateTransferGas(params.rpcUrl, treasury.address, params.tokenAddress, calldata),
  ]);

  const tx: Eip1559Tx = {
    chainId: params.chainId,
    nonce,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    maxFeePerGas: fees.maxFeePerGas,
    gasLimit,
    to: params.tokenAddress,
    value: 0n,
    data: calldata,
  };

  const raw = signEip1559Tx(tx, treasury.hex);
  try {
    const txHash = await rpcCall<string>(params.rpcUrl, "eth_sendRawTransaction", [raw]);
    return { txHash };
  } catch (error) {
    const msg = (error as Error).message;
    // Sanitize: never echo the raw signed tx or the private key in an error.
    throw new Error(`eth_sendRawTransaction failed: ${msg.split("\n")[0]}`);
  }
}
