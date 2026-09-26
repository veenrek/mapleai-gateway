import { decodeAbiParameters, encodeFunctionData, parseAbi } from "viem";
import { config } from "./config.js";

export const nftEnabled = Boolean(config.infuraProjectId);
export const nftPrice = "$0.002";
export const nftNetworks = {
  "ethereum-mainnet": { host: "mainnet.infura.io", chainId: 1 },
  "polygon-mainnet": { host: "polygon-mainnet.infura.io", chainId: 137 },
  "arbitrum-mainnet": { host: "arbitrum-mainnet.infura.io", chainId: 42161 },
  "optimism-mainnet": { host: "optimism-mainnet.infura.io", chainId: 10 },
  "base-mainnet": { host: "base-mainnet.infura.io", chainId: 8453 },
  "linea-mainnet": { host: "linea-mainnet.infura.io", chainId: 59144 },
  "avalanche-mainnet": { host: "avalanche-mainnet.infura.io", chainId: 43114 },
} as const;
export type NftNetwork = keyof typeof nftNetworks;
export const nftExampleAddress = "0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D";
export const nftDescription = "NFT contract metadata via Infura JSON-RPC; $0.002 USDC per request";
const abi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function contractURI() view returns (string)",
  "function supportsInterface(bytes4 interfaceId) view returns (bool)",
]);

export class NftError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export async function getNftMetadata(network: NftNetwork, address: `0x${string}`) {
  const chain = nftNetworks[network];
  const url = "https://" + chain.host + "/v3/" + config.infuraProjectId;
  async function rpc(method: string, params: unknown[], optional = false): Promise<string | null> {
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new NftError(502, "infura_http_error", "Infura request failed (HTTP " + response.status + ")");
    const data = await response.json() as { result?: string; error?: { code?: number; message?: string } };
    if (data.error) {
      // Optional ERC methods commonly revert on contracts that do not implement them.
      if (optional && (data.error.code === 3 || /execution reverted/i.test(data.error.message ?? ""))) return null;
      throw new NftError(502, "infura_rpc_error", "Infura could not complete the metadata query");
    }
    if (typeof data.result !== "string") throw new NftError(502, "infura_invalid_response", "Infura returned an invalid result");
    return data.result;
  }
  const block = await rpc("eth_blockNumber", []);
  const code = await rpc("eth_getCode", [address, block]);
  if (!code || /^0x0*$/.test(code)) throw new NftError(404, "contract_not_found", "No contract exists at this address on the selected network");
  async function call(data: `0x${string}`, type: "string" | "bool") {
    const raw = await rpc("eth_call", [{ to: address, data }, block], true);
    if (!raw || raw === "0x") return null;
    try {
      return type === "string" ? decodeAbiParameters([{ type: "string" }], raw as `0x${string}`)[0]
        : decodeAbiParameters([{ type: "bool" }], raw as `0x${string}`)[0];
    } catch { return null; }
  }
  const [name, symbol, contractURI, erc721, erc1155] = await Promise.all([
    call(encodeFunctionData({ abi, functionName: "name" }), "string"),
    call(encodeFunctionData({ abi, functionName: "symbol" }), "string"),
    call(encodeFunctionData({ abi, functionName: "contractURI" }), "string"),
    call(encodeFunctionData({ abi, functionName: "supportsInterface", args: ["0x80ac58cd"] }), "bool"),
    call(encodeFunctionData({ abi, functionName: "supportsInterface", args: ["0xd9b67a26"] }), "bool"),
  ]);
  return { object: "nft_contract_metadata", chainNetwork: network, chainId: chain.chainId,
    contractAddress: address, blockNumber: block, name, symbol, contractURI,
    tokenType: erc721 === true && erc1155 === true ? "ERC721/ERC1155" : erc721 === true ? "ERC721" : erc1155 === true ? "ERC1155" : "unknown",
    supportsERC721: erc721, supportsERC1155: erc1155 };
}
