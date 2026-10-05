import express from "express";
import { timingSafeEqual } from "node:crypto";
import { x402Facilitator } from "@x402/core/facilitator";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  createPublicClient, createWalletClient, http, isAddress, parseAbi,
  type Chain, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const NETWORK = "eip155:5042";
const ASSET = "0x3600000000000000000000000000000000000000";
const RPC = process.env.ARC_RPC_URL ?? "https://rpc.mainnet.arc.io";
const PAY_TO = process.env.FACILITATOR_PAY_TO;
const TOKEN = process.env.FACILITATOR_TOKEN;
const KEY = process.env.FACILITATOR_PRIVATE_KEY;
const PORT = Number(process.env.FACILITATOR_PORT ?? 4030);

if (!PAY_TO || !isAddress(PAY_TO) || !TOKEN || TOKEN.length < 32 || !KEY || !/^0x[0-9a-fA-F]{64}$/.test(KEY)) {
  throw new Error("FACILITATOR_PAY_TO, FACILITATOR_TOKEN (32+ chars), and FACILITATOR_PRIVATE_KEY are required");
}
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error("Invalid FACILITATOR_PORT");

const chain: Chain = {
  id: 5042,
  name: "Arc",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
};
const account = privateKeyToAccount(KEY as Hex);
const publicClient = createPublicClient({ chain, transport: http(RPC) });
const walletClient = createWalletClient({ chain, account, transport: http(RPC) });

const tokenAbi = parseAbi([
  "function name() view returns (string)",
  "function version() view returns (string)",
  "function decimals() view returns (uint8)",
  "function authorizationState(address, bytes32) view returns (bool)",
]);

async function preflight(): Promise<void> {
  const [id, name, version, decimals, used] = await Promise.all([
    publicClient.getChainId(),
    publicClient.readContract({ address: ASSET, abi: tokenAbi, functionName: "name" }),
    publicClient.readContract({ address: ASSET, abi: tokenAbi, functionName: "version" }),
    publicClient.readContract({ address: ASSET, abi: tokenAbi, functionName: "decimals" }),
    publicClient.readContract({ address: ASSET, abi: tokenAbi, functionName: "authorizationState", args: [account.address, ("0x" + "0".repeat(64)) as Hex] }),
  ]);
  if (id !== 5042 || name !== "USDC" || version !== "2" || decimals !== 6 || used) {
    throw new Error("Arc RPC or USDC contract does not match configured payment scheme");
  }
}

function allowed(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const presented = req.get("authorization")?.replace(/^Bearer /, "") ?? "";
  const a = Buffer.from(presented);
  const b = Buffer.from(TOKEN!);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

function validRequest(body: unknown): body is {
  x402Version: number;
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
} {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  const p = b.paymentPayload as PaymentPayload | undefined;
  const r = b.paymentRequirements as PaymentRequirements | undefined;
  return b.x402Version === 2 && p?.x402Version === 2 &&
    p.accepted?.network === NETWORK && p.accepted?.scheme === "exact" &&
    r?.network === NETWORK && r.scheme === "exact" &&
    r.asset?.toLowerCase() === ASSET.toLowerCase() &&
    p.accepted.asset?.toLowerCase() === ASSET.toLowerCase() &&
    r.payTo?.toLowerCase() === PAY_TO!.toLowerCase() &&
    p.accepted.payTo?.toLowerCase() === PAY_TO!.toLowerCase() &&
    typeof r.amount === "string" && /^[1-9][0-9]*$/.test(r.amount) &&
    r.amount === p.accepted.amount &&
    r.extra?.name === "USDC" && r.extra?.version === "2" &&
    p.accepted.extra?.name === "USDC" && p.accepted.extra?.version === "2" &&
    r.extra?.assetTransferMethod === undefined &&
    p.accepted.extra?.assetTransferMethod === undefined;
}

await preflight();

const signer = {
  address: account.address,
  readContract: (args: Parameters<typeof publicClient.readContract>[0]) => publicClient.readContract(args),
  verifyTypedData: (args: Parameters<import("@x402/evm").FacilitatorEvmSigner["verifyTypedData"]>[0]) =>
    publicClient.verifyTypedData(args as Parameters<typeof publicClient.verifyTypedData>[0]),
  writeContract: (args: Parameters<typeof walletClient.writeContract>[0]) => walletClient.writeContract(args),
  sendTransaction: (args: Parameters<typeof walletClient.sendTransaction>[0]) => walletClient.sendTransaction(args),
  waitForTransactionReceipt: (args: Parameters<typeof publicClient.waitForTransactionReceipt>[0]) => publicClient.waitForTransactionReceipt({ ...args, timeout: 60000 }),
  getCode: (args: Parameters<typeof publicClient.getCode>[0]) => publicClient.getCode(args),
  getAddresses: () => [account.address],
};
const facilitator = new x402Facilitator().register(NETWORK, new ExactEvmScheme(signer));
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));
app.use(allowed);
app.get("/health", (_req, res) => res.json({ status: "ok", network: NETWORK }));
app.get("/supported", (_req, res) => res.json(facilitator.getSupported()));
app.post("/verify", async (req, res) => {
  if (!validRequest(req.body)) return res.status(400).json({ error: "unsupported payment requirements" });
  try {
    res.json(await facilitator.verify(req.body.paymentPayload, req.body.paymentRequirements));
  } catch {
    res.status(502).json({ error: "verification failed" });
  }
});

// Serialize settlement on a single signer so concurrent requests cannot race its nonce.
let settlementQueue = Promise.resolve();
app.post("/settle", async (req, res) => {
  if (!validRequest(req.body)) return res.status(400).json({ error: "unsupported payment requirements" });
  const previous = settlementQueue;
  let release!: () => void;
  settlementQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    res.json(await facilitator.settle(req.body.paymentPayload, req.body.paymentRequirements));
  } catch {
    res.status(502).json({ error: "settlement failed" });
  } finally {
    release();
  }
});
app.listen(PORT, "127.0.0.1", () => console.log("Arc facilitator listening on 127.0.0.1:" + PORT + " wallet " + account.address));
