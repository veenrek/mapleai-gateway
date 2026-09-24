/**
 * Renders the public documents (landing page, AI-AGENTS.md, robots.txt,
 * sitemap.xml) from `templates/`, substituting values computed from the live
 * config and model catalog.
 *
 * This exists because the same documents used to be static files that silently
 * drifted from the deployed config — wrong price, wrong treasury address, wrong
 * host. Rendering them per request makes that class of bug impossible.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { catalog, compactTokens, maxContextWindow, minInputPrice, money } from "./catalog.js";
import { chainInfo } from "./chain.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = join(__dirname, "../templates");

const cache = new Map<string, string>();

function template(name: string): string {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;
  const text = readFileSync(join(TEMPLATE_DIR, name), "utf8");
  cache.set(name, text);
  return text;
}

/** Drop the memoised templates (used by tests / hot reload). */
export function clearTemplateCache(): void {
  cache.clear();
}

export type DocVars = Record<string, string>;

function modelGridHtml(): string {
  return catalog()
    .map(
      (m) => `      <article class="model">
        <h3>${m.id}</h3>
        <div class="meta">${compactTokens(m.contextWindow)} context • ${escapeHtml(m.categories.join(", "))}</div>
        <div class="price">$${money(m.pricing.input)} in / $${money(m.pricing.output)} out per 1M</div>
      </article>`,
    )
    .join("\n");
}

function modelListMarkdown(): string {
  return catalog()
    .map(
      (m) =>
        `- **${m.id}** — ${m.name}, ${compactTokens(m.contextWindow)} context, ` +
        `$${money(m.pricing.input)} in / $${money(m.pricing.output)} out per 1M tokens`,
    )
    .join("\n");
}

function modelTableMarkdown(): string {
  const rows = catalog().map(
    (m) =>
      `| \`${m.id}\` | ${m.name} | ${compactTokens(m.contextWindow)} | ` +
      `$${money(m.pricing.input)} | $${money(m.pricing.output)} |`,
  );
  return [
    "| Model | Name | Context | Input $/1M | Output $/1M |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function developerModelRowsHtml(): string {
  return catalog().map((model) =>
    '<tr><th scope="row"><code>' + escapeHtml(model.id) + '</code><span>' + escapeHtml(model.name) + '</span></th>' +
    "<td>" + compactTokens(model.contextWindow) + "</td><td>$" + money(model.pricing.input) +
    "</td><td>$" + money(model.pricing.output) + "</td></tr>",
  ).join("\n");
}

function developerNetworkRowsHtml(currentNetwork: string): string {
  const networks = [
    { name: "Solana", id: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", origin: "https://sol.mapleai.shop" },
    { name: "Base", id: "eip155:8453", origin: "https://base.mapleai.shop" },
    { name: "Polygon", id: "eip155:137", origin: "https://polygon.mapleai.shop" },
    { name: "Arc", id: "eip155:5042", origin: "https://arc.mapleai.shop" },
  ];
  return networks.map(({ name, id, origin }) =>
    '<tr><th scope="row">' + name + (id === currentNetwork ? " (current)" : "") + "</th>" +
    '<td><code>' + id + '</code></td><td><a href="' + origin + '/developers">' + origin + '</a></td></tr>',
  ).join("\n");
}

function developerJavascriptHtml(network: string, assetAddress: string): string {
  if (network.startsWith("solana:")) {
    return "import { createSvmClient } from '@x402/svm/client';\n" +
      "import { toClientSvmSigner } from '@x402/svm';\n" +
      "import { createKeyPairSignerFromBytes } from '@solana/kit';\n" +
      "import { base58 } from '@scure/base';\n" +
      "const walletSigner = await createKeyPairSignerFromBytes(base58.decode(process.env.SVM_PRIVATE_KEY));\n" +
      "const client = createSvmClient({ signer: toClientSvmSigner(walletSigner) });";
  }
  return "import { x402Client } from '@x402/core/client';\n" +
    "import { registerExactEvmScheme } from '@x402/evm/exact/client';\n" +
    "import { privateKeyToAccount } from 'viem/accounts';\n" +
    "const account = privateKeyToAccount(process.env.EVM_PRIVATE_KEY);\n" +
    "const client = new x402Client().setSpendControls({\n" +
    "  allowedAssets: [{ network: '" + network + "', asset: '" + assetAddress + "', maxAmountPerPayment: '100000' }]\n" +
    "});\n" +
    "registerExactEvmScheme(client, { signer: account, networks: ['" + network + "'] });";
}

/**
 * Build every placeholder value for one request. `origin` is the externally
 * visible base URL (PUBLIC_BASE_URL when configured, else derived from the
 * request) so each instance documents its own host.
 */
export function docVars(origin: string): DocVars {
  const models = catalog();
  const chain = chainInfo(config.network, config.paymentAssetAddress);
  const minPrice = minInputPrice();
  const defaultModel = models[0]?.id ?? "openai/gpt-5.6-sol";
  const brand = config.serviceName;
  const today = new Date().toISOString().slice(0, 10);

  return {
    BRAND: brand,
    ORIGIN: origin,
    API_BASE: `${origin}/v1`,
    CHAIN: chain.label,
    NETWORK: config.network,
    NETWORK_NAME: chain.networkName,
    ASSET: chain.asset,
    ASSET_ADDRESS: chain.assetAddress,
    EXPLORER: chain.explorer,
    FACILITATOR: config.facilitatorUrl,
    PAY_TO: config.payTo,
    CONTACT_EMAIL: config.contactEmail,
    MODEL_COUNT: String(models.length),
    MIN_PRICE: money(minPrice),
    MAX_CONTEXT: compactTokens(maxContextWindow()),
    DEFAULT_MODEL: defaultModel,
    MIN_CHARGE: config.minChargeUsd.toFixed(3),
    MODELS_GRID: modelGridHtml(),
    MODELS_LIST: modelListMarkdown(),
    MODELS_TABLE: modelTableMarkdown(),
    DEVELOPER_MODEL_ROWS: developerModelRowsHtml(),
    DEVELOPER_NETWORK_ROWS: developerNetworkRowsHtml(config.network),
    PAYMENT_NOTE: config.network === "eip155:5042"
      ? "Arc adds a live estimate of settlement gas to the model cost. The exact USDC amount is in the 402 response."
      : "The final quote includes the configured payment overhead and minimum charge. The exact USDC amount is in the 402 response.",
    DEVELOPER_JAVASCRIPT: developerJavascriptHtml(config.network, chain.assetAddress),
    OG_DESCRIPTION:
      `${models.length} GPT models — GPT-5.6 Sol, GPT-5.6 Terra, GPT-6 Luna and GPT-6 Sol — ` +
      `behind one OpenAI-compatible endpoint. Pay per request in ${chain.asset} on ${chain.label}.`,
    YEAR: String(new Date().getUTCFullYear()),
    UPDATED: today,
  };
}

/** Render a template by name, replacing every {{PLACEHOLDER}}. */
export function render(name: string, vars: DocVars): string {
  return template(name).replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, key: string) => {
    const value = vars[key];
    if (value === undefined) {
      console.warn(`[templates] no value for placeholder ${match} in ${name}`);
      return match;
    }
    return value;
  });
}
