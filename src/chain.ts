/**
 * Chain/asset metadata derived from the CAIP-2 network id.
 *
 * Single source of truth for every public document that names the settlement
 * chain, its USDC address or a block explorer — so the landing page, llms.txt,
 * AI-AGENTS.md and the OpenAPI spec can never disagree with NETWORK.
 */

export interface ChainInfo {
  /** Human label, e.g. "Solana" */
  label: string;
  /** Asset symbol */
  asset: string;
  /** Token contract/mint address for the settlement asset */
  assetAddress: string;
  /** Block explorer base URL (no trailing slash) */
  explorer: string;
  /** Human-readable network name, e.g. "Solana mainnet" */
  networkName: string;
  /** True when the network is a testnet (devnet/sepolia) */
  testnet: boolean;
}

const SOLANA_MAINNET_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOLANA_DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const BASE_MAINNET_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const ARC_MAINNET_USDC = "0x3600000000000000000000000000000000000000";
const POLYGON_MAINNET_USDC = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";

/** CAIP-2 ids for the networks this gateway is deployed on. */
const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SOLANA_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const BASE_MAINNET = "eip155:8453";
const BASE_SEPOLIA = "eip155:84532";
const ARC_MAINNET = "eip155:5042";
const POLYGON_MAINNET = "eip155:137";
const ROBINHOOD_MAINNET = "eip155:4663";

export function chainInfo(network: string, paymentAssetAddress?: string): ChainInfo {
  if (network.startsWith("solana:")) {
    const testnet = network === SOLANA_DEVNET;
    return {
      label: "Solana",
      asset: "USDC",
      assetAddress: testnet ? SOLANA_DEVNET_USDC : SOLANA_MAINNET_USDC,
      explorer: testnet ? "https://explorer.solana.com/?cluster=devnet" : "https://explorer.solana.com",
      networkName: testnet ? "Solana devnet" : "Solana mainnet",
      testnet,
    };
  }
  if (network === BASE_MAINNET || network === BASE_SEPOLIA) {
    const testnet = network === BASE_SEPOLIA;
    return {
      label: "Base",
      asset: "USDC",
      assetAddress: testnet ? BASE_SEPOLIA_USDC : BASE_MAINNET_USDC,
      explorer: testnet ? "https://sepolia.basescan.org" : "https://basescan.org",
      networkName: testnet ? "Base Sepolia" : "Base mainnet",
      testnet,
    };
  }
  if (network === ARC_MAINNET) {
    return {
      label: "Arc",
      asset: "USDC",
      assetAddress: ARC_MAINNET_USDC,
      explorer: "https://explorer.arc.io",
      networkName: "Arc mainnet",
      testnet: false,
    };
  }
  if (network === POLYGON_MAINNET) {
    return {
      label: "Polygon",
      asset: "USDC",
      assetAddress: POLYGON_MAINNET_USDC,
      explorer: "https://polygonscan.com",
      networkName: "Polygon mainnet",
      testnet: false,
    };
  }
  if (network === ROBINHOOD_MAINNET) {
    if (!paymentAssetAddress || !/^0x[a-fA-F0-9]{40}$/.test(paymentAssetAddress)) {
      throw new Error("Robinhood Chain requires a verified PAYMENT_ASSET_ADDRESS");
    }
    return {
      label: "Robinhood Chain",
      asset: "USDC",
      assetAddress: paymentAssetAddress,
      explorer: "https://robinhoodchain.blockscout.com",
      networkName: "Robinhood Chain mainnet",
      testnet: false,
    };
  }
  throw new Error("Unsupported payment network: " + network);
}
