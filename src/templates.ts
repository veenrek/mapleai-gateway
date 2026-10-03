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
import { embeddingModel, embeddingsEnabled } from "./embeddings.js";
import { jevEnabled, jevModel, jevPricePerMillion } from "./jev.js";
import { agentsExecuteEnabled } from "./agents.js";
import {
  speechEnabled,
  speechModels,
  speechPriceUsd,
  transcriptionModels,
  transcriptionPriceUsd,
  transcriptionsEnabled,
} from "./audio.js";
import { freeGptOssEnabled, freeGptOssModel } from "./free-gptoss.js";
import { nftEnabled, nftNetworks } from "./nft.js";
import { prepaidCodesEnabled, prepaidStatusUrl } from "./prepaid-codes.js";

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

/** Pack price with enough decimals for sub-cent packs: 0.28, 2.80, 0.007. */
function packPrice(usd: number): string {
  return usd >= 0.01 ? usd.toFixed(2) : usd.toFixed(4).replace(/0+$/, "");
}

function prepaidPriceRowsHtml(): string {
  return catalog()
    .map(
      (m) =>
        `<tr><td><code>${m.id}</code></td><td>$${packPrice(m.pricing.input / 10)}</td><td>$${packPrice(m.pricing.input)}</td></tr>`,
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
    IMAGE_FEATURE: (imagesEnabled ? ', "' + Object.keys(imageRates).length + ' image models"' : '') +
      (jevEnabled ? ', "Jev structured decisions"' : ''),
    HOME_MODEL_SUMMARY: models.length + ' GPT models behind one OpenAI-compatible endpoint.' +
      (imagesEnabled ? ' ' + Object.keys(imageRates).length + ' image models for generation and editing.' : '') +
      (jevEnabled ? ' Jev structured decisions via a separate SystemOne endpoint.' : ''),
    MIN_PRICE: money(minPrice),
    MAX_CONTEXT: compactTokens(maxContextWindow()),
    DEFAULT_MODEL: defaultModel,
    MIN_CHARGE: config.minChargeUsd.toFixed(4),
    MODELS_GRID: modelGridHtml(),
    MODELS_LIST: modelListMarkdown(),
    MODELS_TABLE: modelTableMarkdown(),
    HOME_IMAGES: homeImagesHtml(origin),
    HOME_IMAGE_NAV: imagesEnabled ? '<a href="#images">Images</a>' : '',
    HOME_JEV_NAV: jevEnabled ? '<a href="#jev">Jev</a>' : '',
    HOME_JEV: jevEnabled ? '<section id="jev"><h2>Jev</h2><p class="h2sub">Structured decisions with ' + jevModel +
      ' via SystemOne. $' + jevPricePerMillion?.toFixed(2) + ' per 1M input tokens; output tokens are free.</p><p><code>POST /jev</code> &nbsp; <a href="' +
      origin + '/developers#jev">Jev API guide</a></p></section>' : '',
    AGENT_IMAGES: imagesEnabled ? '## Image Models\n\n' + imageListMarkdown() + '\n\n' +
      'POST ' + origin + '/api/v1/images/generations generates images. POST ' + origin +
      '/api/v1/images/image2image edits a PNG, JPEG or WebP supplied as a base64 data URI (maximum 10 MB). ' +
      'Send model, size, prompt and optional n (1-4); edits also require image. ' +
      'The x402 challenge includes the exact price with payment overhead. Successful responses contain data[].url or data[].b64_json.\n\n' : '',
    AGENT_IMAGE_ENDPOINTS: imagesEnabled ? '| POST | /api/v1/images/generations | Image generation |\n' +
      '| POST | /api/v1/images/image2image | Image editing |' : '',
    AGENT_AUDIO: speechEnabled || transcriptionsEnabled ? '## Audio Models\n\n' +
      (speechEnabled ? '- TTS: ' + speechModels.map((m) => '`' + m + '`').join(', ') + ' — $' + speechPriceUsd.toFixed(3) + ' per request. ' +
        'POST ' + origin + '/v1/audio/speech with JSON model, input (text up to 5000 chars), optional voice and response_format (wav only). ' +
        'OpenAI voice presets (alloy, nova, onyx…) map to Gemini voices; `orpheus-*` models take their own voice names ' +
        '(en: autumn/diana/hannah/austin/daniel/troy, ar: fahad/sultan/noura/lulwa/aisha/abdullah) and emotion tags like [laughs]. ' +
        'speed (0.25-4) is honored on the orpheus models only. Returns an audio/wav stream.\n' : '') +
      (transcriptionsEnabled ? '- STT: ' + transcriptionModels.map((m) => '`' + m + '`').join(', ') + ' — $' + transcriptionPriceUsd.toFixed(3) + ' per request. ' +
        'POST ' + origin + '/v1/audio/transcriptions as multipart form (file + model fields) or JSON {file: base64/data-URI, model}; audio up to 25 MB. ' +
        'response_format: json|text everywhere; verbose_json (word timestamps), srt and vtt only on the whisper-large-v3* models. Returns {"text": ...} or the requested format body.\n' : '') +
      'Every audio response carries `x-audio-upstream` (the vendor/model that served) and `x-fallback-used` (1 = a secondary vendor served after the primary failed; for TTS the voice then differs from the primary).\n\n' : '',
    AGENT_AUDIO_ENDPOINTS: (speechEnabled ? '| POST | /v1/audio/speech | Text-to-speech (WAV) |\n' : '') +
      (transcriptionsEnabled ? '| POST | /v1/audio/transcriptions | Speech-to-text |' : ''),
    HOME_AUDIO_NAV: speechEnabled || transcriptionsEnabled ? '<a href="#audio">Audio</a>' : '',
    HOME_AUDIO: speechEnabled || transcriptionsEnabled ? '<section id="audio"><h2>Audio</h2><p class="h2sub">' +
      (speechEnabled ? 'Text-to-speech (' + speechModels.map((m) => '<code>' + m + '</code>').join(', ') + ', $' + speechPriceUsd.toFixed(3) + '/request)' +
        (transcriptionsEnabled ? ' and ' : '') : '') +
      (transcriptionsEnabled ? 'speech-to-text (' + transcriptionModels.map((m) => '<code>' + m + '</code>').join(', ') + ', $' + transcriptionPriceUsd.toFixed(3) + '/request, word timestamps on whisper-large-v3*)' : '') +
      '.</p><p><code>POST /v1/audio/speech</code> &nbsp; <code>POST /v1/audio/transcriptions</code> &nbsp; <a href="' + origin + '/developers#audio">Audio API guide</a></p></section>' : '',
    DEVELOPER_AUDIO_NAV: speechEnabled || transcriptionsEnabled ? '<a href="#audio">Audio</a>' : '',
    DEVELOPER_AUDIO: speechEnabled || transcriptionsEnabled ? '<section id="audio"><h2>Audio</h2><p class="muted">OpenAI-compatible audio endpoints with x402 USDC payments; flat price per request plus settlement overhead shown in the 402 challenge.</p>' +
      '<dl class="endpoint-list">' +
      (speechEnabled ? '<div><dt>Text-to-speech</dt><dd><code>POST /v1/audio/speech</code> — $' + speechPriceUsd.toFixed(3) + ' / request</dd></div>' : '') +
      (transcriptionsEnabled ? '<div><dt>Speech-to-text</dt><dd><code>POST /v1/audio/transcriptions</code> — $' + transcriptionPriceUsd.toFixed(3) + ' / request</dd></div>' : '') +
      '</dl>' +
      (speechEnabled ? '<div class="table-scroll"><table><thead><tr><th>TTS model</th><th>Backend &amp; voices</th></tr></thead><tbody>' +
        '<tr><td><code>tts-1</code></td><td>Gemini 3.8 Flash Lite; OpenAI presets (alloy, nova, onyx…)</td></tr>' +
        '<tr><td><code>tts-1-hd</code></td><td>Gemini 3.8 Flash; same presets, fuller voice</td></tr>' +
        '<tr><td><code>orpheus-english</code></td><td>Orpheus EN (emotive, [laughs] tags, real speed): autumn, diana, hannah, austin, daniel, troy</td></tr>' +
        '<tr><td><code>orpheus-arabic</code></td><td>Orpheus AR Saudi: fahad, sultan, noura, lulwa, aisha, abdullah</td></tr>' +
        '</tbody></table></div>' : '') +
      (transcriptionsEnabled ? '<div class="table-scroll"><table><thead><tr><th>STT model</th><th>Notes</th></tr></thead><tbody>' +
        '<tr><td><code>whisper-1</code></td><td>Gemini 3.5 Transcribe — default quality, json/text</td></tr>' +
        '<tr><td><code>whisper-large-v3</code></td><td>Groq Whisper v3 — accuracy + verbose_json word timestamps, srt, vtt</td></tr>' +
        '<tr><td><code>whisper-large-v3-turbo</code></td><td>Groq Whisper turbo — fast + same timestamp formats</td></tr>' +
        '</tbody></table></div>' : '') +
      '<div class="snippet"><div class="snippet-title">Text-to-speech</div><pre><code>curl -i ' + origin + '/v1/audio/speech \\\n' +
      '  -H \'content-type: application/json\' \\\n' +
      '  -d \'{"model":"tts-1","input":"Hello from MapleAI","voice":"alloy"}\'</code></pre></div>' +
      '<div class="snippet"><div class="snippet-title">Transcription</div><pre><code>curl -i ' + origin + '/v1/audio/transcriptions \\\n' +
      '  -F file=@clip.mp3 -F model=whisper-large-v3-turbo -F response_format=verbose_json</code></pre></div>' +
      '<p class="muted">Transcription also accepts JSON with <code>file</code> as a base64 string or <code>data:</code> URI (max 25 MB). ' +
      'Responses include <code>x-audio-upstream</code> and <code>x-fallback-used</code> headers; a fallback 1 means a secondary vendor served the request (for TTS the voice then differs).</p></section>' : "",
    AGENT_JEV: jevEnabled ? '## Jev\n\n- ' + jevModel + ': $' + jevPricePerMillion?.toFixed(2) +
      ' per 1M input tokens, output free, plus settlement overhead. POST ' + origin + '/jev uses SystemOne; send model, state and named questions, each with type and instructions. Read answers from the response.\n\n' : '',
    AGENT_JEV_ENDPOINT: jevEnabled ? '| POST | /jev | Jev SystemOne decisions |' : '',
    AGENT_AGENTS: agentsExecuteEnabled ? '## Agents\n\n- agents/oss-20b: $0.002 base + $0.001 per step (charged at the max_steps ceiling, default 8), plus settlement overhead. POST ' + origin + '/v1/agents/execute with model, task, optional context, max_steps (1-20) and tools (calculator, fetch_url). The agent reasons step by step, runs allowed tools server-side, and returns the full step trace, fetched sources and token usage.\n\n' : '',
    AGENT_AGENTS_ENDPOINT: agentsExecuteEnabled ? '| POST | /v1/agents/execute | Autonomous agent execution (oss-20b, tools) |' : '',
    HOME_AGENTS_NAV: agentsExecuteEnabled ? '<a href="#agents">Agents</a>' : '',
    HOME_AGENTS: agentsExecuteEnabled ? '<section id="agents"><h2>Agents</h2><p class="h2sub">Autonomous task execution with agents/oss-20b: multi-step reasoning plus calculator and fetch_url tools. $0.002 base + $0.001 per step, charged at the max_steps ceiling.</p><p><code>POST /v1/agents/execute</code> &nbsp; <a href="' + origin + '/developers#agents">Agents API guide</a></p></section>' : '',
    DEVELOPER_AGENTS_NAV: agentsExecuteEnabled ? '<a href="#agents">Agents</a>' : '',
    DEVELOPER_AGENTS: agentsExecuteEnabled ? '<section id="agents"><h2>Agents</h2><p class="muted">Autonomous task execution via <code>agents/oss-20b</code> (multi-step reasoning with tools). $0.002 base + $0.001 per step, charged at the <code>max_steps</code> ceiling (default 8, maximum 20), plus settlement overhead shown in the 402 challenge. Available tools: <code>calculator</code> (safe arithmetic) and <code>fetch_url</code> (public pages, up to 3 per task).</p>' +
      '<div class="snippet"><div class="snippet-title">Execute a task</div><pre><code>POST ' + origin + '/v1/agents/execute\ncontent-type: application/json\n\n{"model":"agents/oss-20b","task":"What is 12% of 340?","max_steps":6,"tools":["calculator","fetch_url"]}</code></pre></div>' +
      '<p class="muted">The response is an <code>agent.execution</code> object: <code>status</code> (completed | failed | max_steps_exhausted), the full <code>steps</code> trace (thought, tool_call, tool_result), <code>output.result</code> with fetched <code>sources</code>, and per-step plus total token <code>usage</code>.</p></section>' : '',
    AGENT_EMBEDDINGS: embeddingsEnabled ? '## Free Embeddings\n\n- ' + embeddingModel + ': free POST ' + origin + '/v1/embeddings; send input as a string or array of strings.\n\n' : '',
    AGENT_FREE_OSS: freeGptOssEnabled ? '## Free Chat (gpt-oss-20b)\n\n- ' + freeGptOssModel + ': free POST ' + origin + '/v1/free/chat/completions; no payment. Rate-limited ' + config.freeGptOssPer10Min + '/10min and ' + config.freeGptOssPerDay + '/day per agent IP; max_tokens capped at ' + config.freeGptOssMaxTokens + '. Check remaining window: GET ' + origin + '/v1/free/chat/completions/quota.\n\n' : '',
    AGENT_FREE_OSS_ENDPOINT: freeGptOssEnabled ? '| POST | /v1/free/chat/completions | Free gpt-oss-20b chat (quota-limited) |' : '',
    HOME_NFT: nftEnabled ? '<section id="nft"><h2>NFT contract metadata</h2><p class="h2sub">$0.002 USDC per request. Ethereum, Polygon, Arbitrum, Optimism, Base, Linea and Avalanche.</p><p><code>GET /api/v1/{chainNetwork}/nft/getNFTMetadata</code> &nbsp; <a href="/developers#nft">API guide</a></p></section>' : '',
    DEVELOPER_NFT: nftEnabled ? '<section id="nft"><h2>NFT contract metadata</h2><p class="muted">$0.002 USDC per request via x402. Reads on-chain contract metadata through Infura. Returns name, symbol, contractURI, tokenType and ERC interface support; unsupported fields are null. Off-chain metadata and wallet holdings are excluded.</p><div class="snippet"><pre><code>GET ' + origin + '/api/v1/ethereum-mainnet/nft/getNFTMetadata?contractAddress=0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D</code></pre></div><p>Networks: ' + Object.keys(nftNetworks).join(', ') + '. The data network is independent of the USDC payment network selected by domain.</p></section>' : '',
    AGENT_NFT: nftEnabled ? '## NFT Contract Metadata\n\nGET ' + origin + '/api/v1/{chainNetwork}/nft/getNFTMetadata?contractAddress=0x... costs $0.002 USDC per request via x402. Networks: ' + Object.keys(nftNetworks).join(', ') + '. Returns on-chain name, symbol, contractURI, tokenType and ERC interface support; unsupported fields are null. Does not retrieve wallet holdings or off-chain token metadata.\n\n' : '',
    AGENT_PREPAID: prepaidCodesEnabled ? '## Prepaid API Keys\n\nPOST ' + origin + '/prepaid/codes (x402-paid) issues a prepaid bearer key for one GPT model with a token budget in 100000-token steps from 100000 to 1000000, priced at the model input rate plus settlement fee. Use the key at https://mapleai.shop/v1 (OpenAI-compatible). Check usage and status for free: GET ' + prepaidStatusUrl + ' with the prepaid key as the Bearer token — returns valid, reason and tokens total/used/reserved/remaining.\n\nError recovery: an invalid purchase body is answered with availableModels and their pack prices; a prepaid chat call whose model is outside the key returns 403 with the current allowedModels of that key; an exhausted key returns valid=false with reason. In every case the response names ' + prepaidStatusUrl + ' as the refresh URL before buying a new pack.\n\n' : '',
    AGENT_PREPAID_ENDPOINT: prepaidCodesEnabled ? '| POST | /prepaid/codes | Buy a prepaid API key |\n| GET | https://mapleai.shop/v1/prepaid/status | Prepaid key usage and status (free) |' : '',
    HOME_PREPAID_NAV: prepaidCodesEnabled ? '<a href="#prepaid">Prepaid</a>' : '',
    HOME_PREPAID: prepaidCodesEnabled ? '<section id="prepaid"><h2>Prepaid API keys</h2><p class="h2sub">Token packs for one GPT model: 0.1M-1M tokens at the model input rate, in 0.1M steps.</p><p><code>POST /prepaid/codes</code> &nbsp; <a href="/developers#prepaid">API guide</a></p></section>' : '',
    DEVELOPER_PREPAID_NAV: prepaidCodesEnabled ? '<a href="#prepaid">Prepaid</a>' : '',
    DEVELOPER_PREPAID: prepaidCodesEnabled ? '<section id="prepaid"><h2>Prepaid API keys</h2><p class="muted">Buy a prepaid bearer key for one GPT model with x402. The budget counts total tokens (input + output) in 100000-token steps from 100000 to 1000000 and is priced at the model input rate, plus the network settlement fee shown in the 402 challenge. The key works at <code>https://mapleai.shop/v1</code> (OpenAI-compatible).</p>' +
      '<div class="table-scroll"><table><thead><tr><th>Model</th><th>0.1M pack</th><th>1M pack</th></tr></thead><tbody>' + prepaidPriceRowsHtml() + '</tbody></table></div>' +
      '<div class="snippet"><div class="snippet-title">Buy a prepaid key</div><pre><code>POST ' + origin + '/prepaid/codes\ncontent-type: application/json\n\n{"model":"openai/gpt-6-luna","tokens":100000}</code></pre></div>' +
      '<div class="snippet"><div class="snippet-title">Response (after x402 payment)</div><pre><code>{"object":"prepaid_code","code":"oms_buy_...","model":"openai/gpt-6-luna",\n "tokens":{"total":100000,"remaining":100000},\n "api_base":"https://mapleai.shop/v1",\n "status_url":"' + prepaidStatusUrl + '"}</code></pre></div>' +
      '<div class="snippet"><div class="snippet-title">Check key usage and status (free)</div><pre><code>curl ' + prepaidStatusUrl + ' \\\n  -H "Authorization: Bearer oms_buy_..."</code></pre></div>' +
      '<p class="muted">Status returns <code>valid</code>, <code>reason</code> and <code>tokens</code> with total/used/reserved/remaining. An exhausted key answers <code>valid: false, reason: "disabled"</code> — buy a fresh pack to continue.</p></section>' : '',
    DEVELOPER_JEV_NAV: jevEnabled ? '<a href="#jev">Jev</a>' : '',
    DEVELOPER_JEV: jevEnabled ? '<section id="jev"><h2>Jev</h2><p class="muted"><code>' + jevModel +
      '</code> evaluates structured questions through SystemOne. $' + jevPricePerMillion?.toFixed(2) +
      ' per 1M input tokens; output tokens are free. The x402 challenge includes settlement overhead and the exact amount. This model does not support Chat Completions or Responses.</p>' +
      '<div class="snippet"><div class="snippet-title">Jev request</div><pre><code>POST ' + origin +
      '/jev\ncontent-type: application/json\n\n{"model":"jev-latest","state":"The customer was charged twice for one order.","questions":{"billing":{"type":"noul","instructions":"Is this about a billing issue?"}}}</code></pre></div>' +
      '<p class="muted">The JSON response contains <code>answers.billing</code>. Each named question uses a <code>type</code> of <code>noul</code>, <code>choice</code> or <code>score</code> and its own <code>instructions</code>.</p></section>' : '',
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
    OG_DESCRIPTION: models.length + ' GPT models' +
      (imagesEnabled ? ', ' + Object.keys(imageRates).length + ' image models' : '') +
      (jevEnabled ? ', and Jev structured decisions' : '') +
      '. Pay per request in ' + chain.asset + ' on ' + chain.label + ' with x402.',
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
