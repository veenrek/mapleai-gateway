// Minimal EVM JSON-RPC client + ERC-20 Transfer log decoding for the deposit
// watcher. No web3 framework: we issue raw eth_blockNumber / eth_getLogs calls
// and decode the well-known Transfer(address,address,uint256) event.
import { keccak_256 } from "@noble/hashes/sha3";

/** keccak256("Transfer(address,address,uint256)") — the event topic0. */
export const TRANSFER_TOPIC0 =
  "0x" + Buffer.from(keccak_256(new TextEncoder().encode("Transfer(address,address,uint256)"))).toString("hex");

export interface TransferLog {
  txHash: string;
  logIndex: number;
  blockNumber: number;
  tokenAddress: string;
  from: string;
  to: string;
  /** Raw token amount in base units, as a decimal string. */
  amount: string;
}

interface RpcLogEntry {
  address?: string;
  topics?: string[];
  data?: string;
  transactionHash?: string;
  logIndex?: string;
  blockNumber?: string;
}

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
  if (json.result === undefined) {
    throw new Error(`RPC ${method} returned no result`);
  }
  return json.result;
}

/**
 * Low-level `eth_call` against a contract. `data` is the ABI-encoded calldata
 * (0x-prefixed); returns the raw 0x-prefixed return data. Used for read-only
 * view calls such as Chainlink aggregator reads.
 */
export async function ethCall(rpcUrl: string, to: string, data: string): Promise<string> {
  return rpcCall<string>(rpcUrl, "eth_call", [{ to, data }, "latest"]);
}

export async function getBlockNumber(rpcUrl: string): Promise<number> {
  const hex = await rpcCall<string>(rpcUrl, "eth_blockNumber", []);
  return parseInt(hex, 16);
}

export interface TxReceiptInfo {
  /** Canonical block number of the tx, or null if the tx is not found / dropped. */
  blockNumber: number | null;
  /** 1 = success, 0 = reverted, null if unknown / not mined. */
  status: number | null;
}

/**
 * Look up a transaction receipt. A null receipt (tx dropped by a reorg or never
 * mined) yields `{ blockNumber: null, status: null }`.
 */
export async function getTransactionReceipt(
  rpcUrl: string,
  txHash: string
): Promise<TxReceiptInfo> {
  const receipt = await rpcCall<{ blockNumber?: string; status?: string } | null>(
    rpcUrl,
    "eth_getTransactionReceipt",
    [txHash]
  );
  if (!receipt) return { blockNumber: null, status: null };
  return {
    blockNumber: receipt.blockNumber ? parseInt(receipt.blockNumber, 16) : null,
    status: receipt.status != null ? parseInt(receipt.status, 16) : null,
  };
}

/**
 * True when the node knows about a transaction at all (mined or still pending in
 * the mempool). A `false` result means the node has neither a mined tx nor a
 * mempool entry for this hash — i.e. it was dropped/never propagated. Used to
 * distinguish "not mined yet" (keep waiting) from "gone" (safe to refund).
 */
export async function isTransactionKnown(rpcUrl: string, txHash: string): Promise<boolean> {
  const tx = await rpcCall<{ hash?: string } | null>(rpcUrl, "eth_getTransactionByHash", [txHash]);
  return Boolean(tx && tx.hash);
}

function toHexBlock(n: number): string {
  return "0x" + n.toString(16);
}

/**
 * A 20-byte address left-padded to 32 bytes, as used in indexed topic slots.
 */
function addressToTopic(address: string): string {
  const clean = address.toLowerCase().replace(/^0x/, "");
  return "0x" + clean.padStart(64, "0");
}

/**
 * Extract a 20-byte address from a 32-byte topic word.
 */
function topicToAddress(topic: string): string {
  const clean = topic.replace(/^0x/, "");
  return "0x" + clean.slice(-40).toLowerCase();
}

/**
 * Fetch ERC-20 Transfer logs for the given token where `to` is one of the
 * supplied deposit addresses, across [fromBlock, toBlock]. Recipients are
 * filtered in the topic query so the node only returns relevant logs.
 *
 * eth_getLogs accepts an array in a topic position as an OR set, so we pass all
 * deposit addresses as the indexed `to` (topic[2]) filter in a single call.
 */
export async function getDepositTransferLogs(params: {
  rpcUrl: string;
  tokenAddress: string;
  toAddresses: string[];
  fromBlock: number;
  toBlock: number;
}): Promise<TransferLog[]> {
  if (params.toAddresses.length === 0) return [];

  const filter = {
    address: params.tokenAddress,
    fromBlock: toHexBlock(params.fromBlock),
    toBlock: toHexBlock(params.toBlock),
    topics: [
      TRANSFER_TOPIC0,
      null, // from: any
      params.toAddresses.map(addressToTopic), // to: any of our deposit addresses
    ],
  };

  const logs = await rpcCall<RpcLogEntry[]>(params.rpcUrl, "eth_getLogs", [filter]);
  const out: TransferLog[] = [];
  for (const log of logs) {
    if (!log.topics || log.topics.length < 3 || !log.data) continue;
    if (log.topics[0].toLowerCase() !== TRANSFER_TOPIC0.toLowerCase()) continue;
    out.push({
      txHash: log.transactionHash || "",
      logIndex: log.logIndex ? parseInt(log.logIndex, 16) : 0,
      blockNumber: log.blockNumber ? parseInt(log.blockNumber, 16) : 0,
      tokenAddress: (log.address || params.tokenAddress).toLowerCase(),
      from: topicToAddress(log.topics[1]),
      to: topicToAddress(log.topics[2]),
      amount: BigInt(log.data).toString(10),
    });
  }
  return out;
}
