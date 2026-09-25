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
import { imageRates, imagesEnabled } from "./images.js";

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

function developerImageRowsHtml(): string {
  return Object.entries(imageRates).flatMap(([model, sizes]) => Object.entries(sizes).map(([size, price]) =>
    '<tr><th scope="row"><code>' + escapeHtml(model) + '</code></th><td>' + escapeHtml(size) +
    '</td><td>$' + price.toFixed(4) + '</td></tr>',
  )).join("\n");
}

function imageListMarkdown(): string {
  return Object.entries(imageRates).flatMap(([model, sizes]) => Object.entries(sizes).map(([size, price]) =>
    "- " + model + " (" + size + "): $" + price.toFixed(4) + " per image",
  )).join("\n");
}

function homeImagesHtml(origin: string): string {
  if (!imagesEnabled) return "";
  return '<section id="images"><h2>Images</h2><p class="h2sub">Generate and edit images with a per-image x402 quote.</p>' +
    '<div class="table-scroll"><table><thead><tr><th>Model</th><th>Size</th><th>USD / image</th></tr></thead><tbody>' +
    developerImageRowsHtml() + '</tbody></table></div>' +
    '<p class="image-links"><code>POST /api/v1/images/generations</code><br>' +
    '<code>POST /api/v1/images/image2image</code><br>' +
    '<a href="' + origin + '/developers#images">Image API guide</a> | ' +
    '<a href="' + origin + '/openapi.json">OpenAPI</a></p></section>';
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
    IMAGE_FEATURE: imagesEnabled ? ', "' + Object.keys(imageRates).length + ' image models"' : '',
    HOME_MODEL_SUMMARY: imagesEnabled
      ? models.length + ' GPT models and ' + Object.keys(imageRates).length + ' image models for generation and editing.'
      : models.length + ' GPT models behind one OpenAI-compatible endpoint.',
    MIN_PRICE: money(minPrice),
    MAX_CONTEXT: compactTokens(maxContextWindow()),
    DEFAULT_MODEL: defaultModel,
    MIN_CHARGE: config.minChargeUsd.toFixed(3),
    MODELS_GRID: modelGridHtml(),
    MODELS_LIST: modelListMarkdown(),
    MODELS_TABLE: modelTableMarkdown(),
    HOME_IMAGES: homeImagesHtml(origin),
    HOME_IMAGE_NAV: imagesEnabled ? '<a href="#images">Images</a>' : '',
    AGENT_IMAGES: imagesEnabled ? '## Image Models\n\n' + imageListMarkdown() + '\n\n' +
      'POST ' + origin + '/api/v1/images/generations generates images. POST ' + origin +
      '/api/v1/images/image2image edits a PNG, JPEG or WebP supplied as a base64 data URI (maximum 10 MB). ' +
      'Send model, size, prompt and optional n (1-4); edits also require image. ' +
      'The x402 challenge includes the exact price with payment overhead. Successful responses contain data[].url or data[].b64_json.\n\n' : '',
    AGENT_IMAGE_ENDPOINTS: imagesEnabled ? '| POST | /api/v1/images/generations | Image generation |\n' +
      '| POST | /api/v1/images/image2image | Image editing |' : '',
    DEVELOPER_MODEL_ROWS: developerModelRowsHtml(),
    DEVELOPER_IMAGES: imagesEnabled ? '<section id="images"><h2>Images</h2><p class="muted">Generate or edit images with x402 USDC payments. The exact quote includes payment overhead.</p>' +
      '<dl class="endpoint-list"><div><dt>Generate</dt><dd><code>POST /api/v1/images/generations</code></dd></div>' +
      '<div><dt>Edit</dt><dd><code>POST /api/v1/images/image2image</code></dd></div></dl>' +
      '<div class="table-scroll"><table><thead><tr><th>Model</th><th>Size</th><th>USD / image</th></tr></thead><tbody>' +
      developerImageRowsHtml() + '</tbody></table></div>' +
      '<div class="snippet"><div class="snippet-title">Image request</div><pre><code>curl -i ' + origin + '/api/v1/images/generations \\\n' +
      '  -H \'content-type: application/json\' \\\n' +
      '  -d \'{"model":"' + Object.keys(imageRates)[0] + '","size":"' + Object.keys(imageRates[Object.keys(imageRates)[0]])[0] +
      '","prompt":"A maple leaf","n":1}\'</code></pre></div>' +
      '<p class="muted">For image2image, add <code>image</code> as a PNG, JPEG or WebP base64 data URI. Both routes return <code>data[].url</code> or <code>data[].b64_json</code>.</p></section>' : "",
    DEVELOPER_NETWORK_ROWS: developerNetworkRowsHtml(config.network),
    PAYMENT_NOTE: config.network === "eip155:5042"
      ? "Arc adds a live estimate of settlement gas to the model cost. The exact USDC amount is in the 402 response."
      : "The final quote includes the configured payment overhead and minimum charge. The exact USDC amount is in the 402 response.",
    DEVELOPER_JAVASCRIPT: developerJavascriptHtml(config.network, chain.assetAddress),
    OG_DESCRIPTION: imagesEnabled
      ? models.length + ' GPT models and ' + Object.keys(imageRates).length + ' image models for generation and editing. ' +
        'Pay per request in ' + chain.asset + ' on ' + chain.label + ' with x402.'
      : models.length + ' GPT models behind one OpenAI-compatible endpoint. ' +
        'Pay per request in ' + chain.asset + ' on ' + chain.label + ' with x402.',
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
