import express, { type Request, type Response } from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { createCdpFacilitatorClient, CDP_FACILITATOR_URL } from "@coinbase/cdp-sdk/x402";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { HTTPFacilitatorClient, type HTTPRequestContext } from "@x402/core/server";
import { convertToTokenAmount } from "@x402/core/utils";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

type DynamicPrice = (context: HTTPRequestContext) => string | Promise<string>;
import { config } from "./config.js";
import { catalog, compactTokens, maxContextWindow, minInputPrice, money } from "./catalog.js";
import { chainInfo } from "./chain.js";
import { canonicalModelId, upstreamModelId } from "./models.js";
import { estimateOutputTokens, quotePrice, quoteBreakdown } from "./pricing.js";
import { paymentOverheadUsd } from "./gas.js";
import { actualCostUsd, extractPayer, parseUsage, parseUsageFromSse, recordUsage } from "./ledger.js";
import { paymentEventMiddleware } from "./payment-events.js";
import { fetchUpstreamChat } from "./upstream.js";
import { fetchImage, imageModels, imageRates, imagesEnabled, quoteImage, validateImage, type ImageKind, type ImageRequest } from "./images.js";
import { fetchJev, jevEnabled, jevModel, jevPricePerMillion, quoteJev, validateJev } from "./jev.js";
import { embeddingModel, embeddingsEnabled, fetchEmbeddings, validateEmbedding } from "./embeddings.js";
import { embeddingStats, recordEmbeddingData, trackEmbeddingRequest } from "./embedding-stats.js";
import { getNftMetadata, NftError, nftEnabled, nftPrice, nftNetworks, nftExampleAddress, nftDescription, type NftNetwork } from "./nft.js";
import {
  toChatRequest,
  toResponsesObject,
  toResponsesSse,
  type ResponsesRequestBody,
} from "./responses.js";
import { docVars, render } from "./templates.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "../public");

const chain = chainInfo(config.network, config.paymentAssetAddress);
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);
if (embeddingsEnabled) app.post("/v1/embeddings", (req, res, next) => { trackEmbeddingRequest(req, res); next(); });
const parseJson = express.json({ limit: "15mb" });
app.use((req, res, next) => {
  parseJson(req, res, (error) => {
    if (error && req.method === "POST" && req.path === "/v1/embeddings") {
      res.locals.embeddingFailure = { source: "validation", reason: error.type ?? "invalid_body", message: "Request body could not be parsed" };
    }
    next(error);
  });
});
app.use(paymentEventMiddleware);

// ---------------------------------------------------------------------------
// x402 resource server
// ---------------------------------------------------------------------------

const httpFacilitator = new HTTPFacilitatorClient({
  url: config.facilitatorUrl,
  ...(config.facilitatorToken ? {
    createAuthHeaders: async () => {
      const headers = { Authorization: "Bearer " + config.facilitatorToken };
      return { supported: headers, verify: headers, settle: headers };
    },
  } : {}),
});
if (config.facilitatorMode !== "http" && config.facilitatorMode !== "cdp") {
  throw new Error("FACILITATOR_MODE must be http or cdp");
}
const cdpSupportedNetworks = new Set([
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  "eip155:8453",
  "eip155:84532",
  "eip155:137",
]);
if (config.facilitatorMode === "cdp" && !cdpSupportedNetworks.has(config.network)) {
  throw new Error("CDP facilitator does not support configured network " + config.network);
}
const facilitator = config.facilitatorMode === "cdp"
  ? createCdpFacilitatorClient()
  : httpFacilitator;
const evmScheme = new ExactEvmScheme();
if (config.network === "eip155:5042") {
  evmScheme.registerMoneyParser(async (amount) => ({
    amount: convertToTokenAmount(String(amount), 6),
    asset: chain.assetAddress,
    extra: { name: "USDC", version: "2" },
  }));
}
const resourceServer = new x402ResourceServer(facilitator).register(
  config.network,
  config.network.startsWith("solana:") ? new ExactSvmScheme() : evmScheme,
);
resourceServer.registerExtension(bazaarResourceServerExtension);

/** Parsed request body (express.json() runs first, and the paywall needs it to price). */
function requestBody(context: HTTPRequestContext): Record<string, unknown> {
  const adapter = context.adapter as unknown as {
    getBody?: () => unknown;
    req?: Request;
  };
  const body = typeof adapter.getBody === "function" ? adapter.getBody() : adapter.req?.body;
  return (body ?? {}) as Record<string, unknown>;
}

const quotedPrice: DynamicPrice = async (context) => {
  const current = await quotePrice(requestBody(context) as never);
  if (config.network !== "eip155:5042" || !context.paymentHeader) return current;
  try {
    const signed = JSON.parse(Buffer.from(context.paymentHeader, "base64").toString("utf8"));
    const accepted = signed?.accepted;
    if (signed?.x402Version !== 2 || accepted?.network !== config.network ||
        accepted?.scheme !== "exact" ||
        accepted?.asset?.toLowerCase() !== chain.assetAddress.toLowerCase() ||
        accepted?.payTo?.toLowerCase() !== config.payTo.toLowerCase() ||
        typeof accepted?.amount !== "string" || !/^[1-9][0-9]*$/.test(accepted.amount)) {
      return current;
    }
    const paid = BigInt(accepted.amount);
    const minimum = BigInt(Math.round(Number(current.slice(1)) * 1_000_000));
    if (paid < minimum) return current;
    return "$" + (Number(paid) / 1_000_000).toFixed(6);
  } catch {
    return current;
  }
};

/**
 * `quote` extension: BlockRun-style transparency in every 402 — the challenge
 * carries the counted input tokens, assumed output tokens and total price, and
 * each accepts entry gets a human-readable description with the breakdown.
 */
resourceServer.registerExtension({
  key: "quote",
  dynamicInfoFields: ["inputTokens", "outputTokens", "price", "paymentOverheadUsd"],
  async enrichPaymentRequiredResponse(_declaration, context) {
    const transport = context.transportContext as { request?: HTTPRequestContext } | undefined;
    const body = transport?.request ? requestBody(transport.request) : {};
    const quote = await quoteBreakdown(body as { model?: string });

    for (const accept of context.paymentRequiredResponse.accepts) {
      accept.extra = {
        ...(accept.extra ?? {}),
        description:
          `${quote.model ?? "model"} API call ` +
          `(~${quote.inputTokens ?? "?"} input, ${quote.outputTokens ?? "?"} max output tokens)`,
      };
    }
    return quote;
  },
});

const CATALOG_SUMMARY = () => `${catalog().length} GPT models, ${imageModels.length} image models` +
  (jevEnabled ? ", Jev structured decisions" : "") + `; x402 on ${chain.networkName}`;

const chatDiscovery = declareDiscoveryExtension({
  input: {
    model: "openai/gpt-6-luna",
    messages: [{ role: "user", content: "Hello" }],
    max_tokens: 64,
  },
  inputSchema: {
    type: "object",
    required: ["model", "messages"],
    properties: {
      model: { type: "string", description: "Model ID from GET /v1/models" },
      messages: {
        type: "array",
        items: {
          type: "object",
          required: ["role", "content"],
          properties: {
            role: { type: "string", enum: ["system", "user", "assistant", "tool"] },
            content: { type: "string" },
          },
        },
      },
      max_tokens: { type: "integer", minimum: 1 },
    },
  },
  bodyType: "json",
  output: {
    example: {
      id: "chatcmpl_example",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "Hello!" }, finish_reason: "stop" }],
    },
  },
});

const responsesDiscovery = declareDiscoveryExtension({
  input: { model: "openai/gpt-6-luna", input: "Hello", max_output_tokens: 64 },
  inputSchema: {
    type: "object",
    required: ["model", "input"],
    properties: {
      model: { type: "string", description: "Model ID from GET /v1/models" },
      input: { type: "string" },
      max_output_tokens: { type: "integer", minimum: 1 },
    },
  },
  bodyType: "json",
  output: {
    example: {
      id: "resp_example",
      object: "response",
      status: "completed",
      output_text: "Hello!",
      output: [],
    },
  },
});

/** Every paid route shares one pricing rule; only the discovery shape differs. */
function paidRoute(description: string, discovery: ReturnType<typeof declareDiscoveryExtension>, price: DynamicPrice = quotedPrice, includeQuote = true) {
  return {
    accepts: {
      scheme: "exact",
      price,
      network: config.network,
      payTo: config.payTo,
      maxTimeoutSeconds: 120,
    },
    description,
    mimeType: "application/json",
    extensions: { ...(includeQuote ? { quote: {} } : {}), ...discovery },
  };
}

const CHAT_DESCRIPTION =
  "OpenAI-compatible chat completion, priced by counted input tokens + max output tokens at per-model rates";

const imageExampleModel = imageModels[0] ?? "gpt-image-2";
const imageExampleSize = Object.keys(imageRates[imageExampleModel] ?? {})[0] ?? "1024x1024";
const imageExample = { model: imageExampleModel, size: imageExampleSize, n: 1, prompt: "A maple leaf" };
// A complete 1x1 PNG keeps discovery probes small while passing edit validation.
const imageEditExample = {
  ...imageExample,
  prompt: "Make the leaf green",
  image: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
};

const imageDiscovery = declareDiscoveryExtension({
  input: imageExample,
  inputSchema: { type: "object", required: ["model", "size", "prompt"], properties: {
    model: { type: "string", enum: imageModels },
    size: { type: "string" }, n: { type: "integer", minimum: 1, maximum: 4 },
    prompt: { type: "string" },
  } },
  bodyType: "json",
  output: { example: { created: 1700000000, data: [{ url: "https://example.com/image.png" }] } },
});
const editDiscovery = declareDiscoveryExtension({
  input: imageEditExample,
  inputSchema: { type: "object", required: ["model", "size", "prompt", "image"], properties: {
    model: { type: "string", enum: imageModels }, size: { type: "string" },
    n: { type: "integer", minimum: 1, maximum: 4 }, prompt: { type: "string" },
    image: { type: "string", description: "PNG, JPEG or WebP data URI, maximum 10 MB" },
  } },
  bodyType: "json",
  output: { example: { created: 1700000000, data: [{ url: "https://example.com/image.png" }] } },
});

const jevExample = { model: jevModel, state: "The customer was charged twice for one order.",
  questions: { billing: { type: "noul", instructions: "Is this about a billing issue?" } } };
const jevSchema = { type: "object", required: ["model", "state", "questions"], properties: {
  model: { type: "string", enum: [jevModel], example: jevModel },
  state: { type: "string", example: jevExample.state },
  questions: { type: "object", example: jevExample.questions,
    description: "Named questions. Each value needs type (noul, choice or score) and instructions.",
    additionalProperties: { type: "object", required: ["type", "instructions"], properties: {
      type: { type: "string", enum: ["noul", "choice", "score"] },
      instructions: { type: "string" },
    } },
  },
} };
const jevDiscovery = declareDiscoveryExtension({ input: jevExample, inputSchema: jevSchema, bodyType: "json",
  output: { example: { model: "jev-1.13.0", answers: { billing: { type: "noul", noul: 0.98 } },
    usage: { input_tokens: 282, output_tokens: 20 } } } });

if (imagesEnabled) {
  app.post("/api/v1/images/generations", validateImage("generation"));
  app.post("/api/v1/images/image2image", validateImage("edit"));
}
if (jevEnabled) app.post("/jev", validateJev);
if (embeddingsEnabled) app.post("/v1/embeddings", validateEmbedding);

const PAID_ROUTES = {
  ...(nftEnabled ? Object.fromEntries(Object.keys(nftNetworks).map((network) => [
    "GET /api/v1/" + network + "/nft/getNFTMetadata",
    paidRoute(nftDescription, declareDiscoveryExtension({
      input: { contractAddress: nftExampleAddress },
      inputSchema: { type: "object", required: ["contractAddress"], properties: { contractAddress: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" } } },
      output: { example: { object: "nft_contract_metadata", chainNetwork: network, contractAddress: nftExampleAddress, name: "BoredApeYachtClub", symbol: "BAYC", tokenType: "ERC721" } },
    }), async () => nftPrice, false),
  ])) : {}),
  "POST /v1/chat/completions": paidRoute(CHAT_DESCRIPTION, chatDiscovery),
  "POST /api/v1/chat/completions": paidRoute(CHAT_DESCRIPTION, chatDiscovery),
  "POST /api/v1/responses": paidRoute(
    "OpenAI-compatible Responses API (alpha), translated to chat completions upstream",
    responsesDiscovery,
  ),
  "POST /v1/responses": paidRoute(
    "OpenAI-compatible Responses API (alpha), translated to chat completions upstream",
    responsesDiscovery,
  ),
  ...(imagesEnabled ? {
    "POST /api/v1/images/generations": paidRoute("Generate images, priced per image and size", imageDiscovery, (context) => quoteImage(requestBody(context)), false),
    "POST /api/v1/images/image2image": paidRoute("Edit an image, priced per image and size", editDiscovery, (context) => quoteImage(requestBody(context)), false),
  } : {}),
  ...(jevEnabled ? { "POST /jev": paidRoute("Jev structured decisions via SystemOne, priced by input tokens",
    jevDiscovery, (context) => quoteJev(requestBody(context) as { state: unknown; questions: unknown }), false) } : {}),
};

app.use(paymentMiddleware(PAID_ROUTES, resourceServer));

if (nftEnabled) {
  for (const network of Object.keys(nftNetworks) as NftNetwork[]) {
    app.get("/api/v1/" + network + "/nft/getNFTMetadata", async (req, res) => {
      const address = req.query.contractAddress;
      if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
        res.status(400).json({ error: { type: "invalid_request", message: "contractAddress must be a 20-byte EVM address" } }); return;
      }
      try {
        res.json(await getNftMetadata(network, address as `0x${string}`));
      } catch (error) {
        const known = error instanceof NftError;
        res.status(known ? error.status : 502).json({ error: { type: "nft_metadata_error", code: known ? error.code : "upstream_unavailable", message: known ? error.message : "NFT metadata provider unavailable" } });
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Upstream proxy
// ---------------------------------------------------------------------------

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-length",
  "content-encoding",
]);

/** Externally visible origin: configured value, else the request's own host. */
function originOf(req: Request): string {
  return config.publicBaseUrl || `${req.protocol}://${req.get("host")}`;
}

/**
 * Validate the requested model against the sellable catalog.
 * Returns the canonical id, or writes a 400 and returns undefined.
 */
function resolveModel(req: Request, res: Response): string | undefined {
  const requested = typeof req.body?.model === "string" ? req.body.model : undefined;
  const canonical = canonicalModelId(requested);
  if (!canonical) {
    res.status(400).json({
      error: {
        message: `unknown model: ${requested ?? "(missing)"}. See GET /v1/models`,
        type: "invalid_request",
        code: "model_not_found",
      },
    });
    return undefined;
  }
  return canonical;
}

function logUsage(record: {
  model?: string;
  payer?: string;
  upstreamStatus: number;
  quotedUsd?: string;
  usage?: { promptTokens?: number; completionTokens?: number };
}): void {
  console.log(
    `[usage] model=${record.model} payer=${record.payer ?? "?"} ` +
      `in=${record.usage?.promptTokens ?? "?"} out=${record.usage?.completionTokens ?? "?"} ` +
      `quoted=${record.quotedUsd} status=${record.upstreamStatus}`,
  );
}

/**
 * POST /v1/chat/completions (+ /api/v1/chat/completions alias)
 *
 * Proxies to the upstream provider, translating our canonical model id to the
 * provider's id. A `stream: true` request is piped straight through as SSE while
 * its tail is retained to recover usage for the ledger.
 */
async function handleChatCompletions(req: Request, res: Response): Promise<void> {
  const model = resolveModel(req, res);
  if (!model) return;

  const upstreamModel = upstreamModelId(model);
  const wantsStream = req.body?.stream === true;

  // Ask for a usage chunk on streams so the ledger can reconcile the quote.
  const buildBody = (includeUsage: boolean): string => {
    const body: Record<string, unknown> = { ...req.body, model: upstreamModel };
    if (includeUsage && wantsStream) body.stream_options = { include_usage: true };
    if (body.max_tokens === undefined && body.max_completion_tokens === undefined) {
      body.max_tokens = estimateOutputTokens(req.body);
    }
    return JSON.stringify(body);
  };

  const payer = extractPayer(req.headers["payment-signature"] as string | undefined);
  const quotedUsd = await quotePrice(req.body);

  try {
    let upstream = await fetchUpstreamChat(buildBody(true));

    // Some OpenAI-compatible providers reject stream_options; retry once without.
    if (upstream.status === 400 && wantsStream) {
      const sniff = await upstream.clone().text();
      if (sniff.includes("stream_options")) {
        upstream = await fetchUpstreamChat(buildBody(false));
      } else {
        res.status(upstream.status).type("application/json").send(sniff);
        return;
      }
    }

    // Non-2xx: forward the upstream status so the x402 middleware cancels the
    // verified payment instead of settling it on a failed request.
    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text();
      recordUsage({
        ts: new Date().toISOString(),
        model,
        payer,
        upstreamStatus: upstream.status,
        quotedUsd,
      });
      console.error(`[proxy] upstream ${upstream.status}: ${text.slice(0, 500)}`);
      res.status(upstream.status).type("application/json").send(text);
      return;
    }

    for (const [name, value] of upstream.headers) {
      if (!HOP_BY_HOP.has(name.toLowerCase()) && name.toLowerCase() !== "content-type") {
        res.setHeader(name, value);
      }
    }

    if (wantsStream) {
      res.status(upstream.status);
      res.setHeader("content-type", "text/event-stream; charset=utf-8");
      res.setHeader("cache-control", "no-cache, no-transform");
      res.setHeader("x-accel-buffering", "no");

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let tail = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        tail = (tail + decoder.decode(value, { stream: true })).slice(-65536);
        res.write(Buffer.from(value));
      }
      res.end();

      const usage = parseUsageFromSse(tail);
      const record = {
        ts: new Date().toISOString(),
        model,
        payer,
        upstreamStatus: upstream.status,
        quotedUsd,
        usage,
        actualCostUsd: actualCostUsd(model, usage),
      };
      recordUsage(record);
      logUsage(record);
      return;
    }

    const body = Buffer.from(await upstream.arrayBuffer());
    const usage = parseUsage(body);
    const record = {
      ts: new Date().toISOString(),
      model,
      payer,
      upstreamStatus: upstream.status,
      quotedUsd,
      usage,
      actualCostUsd: actualCostUsd(model, usage),
    };
    recordUsage(record);
    logUsage(record);

    res.status(upstream.status);
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.send(body);
  } catch (error) {
    console.error("[proxy] upstream error:", error);
    res
      .status(502)
      .json({ error: { message: "upstream request failed", type: "upstream_error" } });
  }
}

app.post(["/v1/chat/completions", "/api/v1/chat/completions"], handleChatCompletions);

/**
 * POST /api/v1/responses (+ /v1/responses) — OpenAI Responses API (alpha).
 *
 * Upstream only speaks chat completions, so the request is translated, the
 * completion is mapped back to a Responses object, and `stream: true` emits the
 * `response.*` event sequence.
 */
async function handleResponses(req: Request, res: Response): Promise<void> {
  const model = resolveModel(req, res);
  if (!model) return;

  const body = req.body as ResponsesRequestBody;
  const wantsStream = body.stream === true;
  const chatRequest = toChatRequest(body, upstreamModelId(model));
  delete chatRequest.stream;
  if (chatRequest.max_tokens === undefined) chatRequest.max_tokens = estimateOutputTokens(body);

  const payer = extractPayer(req.headers["payment-signature"] as string | undefined);
  const quotedUsd = await quotePrice(req.body);

  try {
    const upstream = await fetchUpstreamChat(JSON.stringify(chatRequest));
    const text = await upstream.text();

    if (!upstream.ok) {
      recordUsage({
        ts: new Date().toISOString(),
        model,
        payer,
        upstreamStatus: upstream.status,
        quotedUsd,
      });
      console.error(`[responses] upstream ${upstream.status}: ${text.slice(0, 500)}`);
      res.status(upstream.status).type("application/json").send(text);
      return;
    }

    const chat = JSON.parse(text) as Parameters<typeof toResponsesObject>[0];
    const response = toResponsesObject(chat, model);
    const usage = parseUsage(Buffer.from(text));
    const record = {
      ts: new Date().toISOString(),
      model,
      payer,
      upstreamStatus: upstream.status,
      quotedUsd,
      usage,
      actualCostUsd: actualCostUsd(model, usage),
    };
    recordUsage(record);
    logUsage(record);

    if (wantsStream) {
      res.status(200);
      res.setHeader("content-type", "text/event-stream; charset=utf-8");
      res.setHeader("cache-control", "no-cache, no-transform");
      res.setHeader("x-accel-buffering", "no");
      res.send(toResponsesSse(response));
      return;
    }

    res.status(200).json(response);
  } catch (error) {
    console.error("[responses] upstream error:", error);
    res.status(502).json({ error: { message: "upstream request failed", type: "upstream_error" } });
  }
}

app.post(["/api/v1/responses", "/v1/responses"], handleResponses);

async function handleImage(req: Request, res: Response, kind: ImageKind): Promise<void> {
  const image = res.locals.imageRequest as ImageRequest;
  try {
    const upstream = await fetchImage(image, kind);
    const raw = await upstream.text();
    if (!upstream.ok) {
      console.error("[images] upstream " + upstream.status + ": " + raw.slice(0, 400));
      res.status(upstream.status).type("application/json").send(raw);
      return;
    }
    const data: unknown = JSON.parse(raw);
    if (!data || typeof data !== "object" || !Array.isArray((data as { data?: unknown }).data) ||
        (data as { data: unknown[] }).data.length !== image.n) {
      console.error("[images] unexpected upstream response for " + image.model);
      res.status(502).json({ error: { message: "Unexpected upstream image response" } });
      return;
    }
    const results = (data as { data: Array<{ url?: unknown; b64_json?: unknown }> }).data;
    if (results.some((item) => !item || (typeof item.url !== "string" && typeof item.b64_json !== "string"))) {
      res.status(502).json({ error: { message: "Missing image data in upstream response" } });
      return;
    }
    recordUsage({ ts: new Date().toISOString(), model: image.model, payer: extractPayer(req.get("payment-signature")),
      upstreamStatus: upstream.status, quotedUsd: await quoteImage(req.body) });
    res.status(200).json(data);
  } catch (error) {
    console.error("[images] upstream error:", error);
    res.status(502).json({ error: { message: "Image request failed" } });
  }
}

if (imagesEnabled) {
  app.post("/api/v1/images/generations", (req, res) => { void handleImage(req, res, "generation"); });
  app.post("/api/v1/images/image2image", (req, res) => { void handleImage(req, res, "edit"); });
}

if (jevEnabled) app.post("/jev", async (req, res) => {
  try {
    const upstream = await fetchJev(req.body);
    const raw = await upstream.text();
    if (!upstream.ok) {
      console.error("[jev] upstream HTTP " + upstream.status);
      res.status(upstream.status).type("application/json").send(raw);
      return;
    }
    let data: unknown;
    try { data = JSON.parse(raw); } catch { data = undefined; }
    if (!data || typeof data !== "object" || !("answers" in data)) {
      res.status(502).json({ error: { message: "Unexpected Jev response", type: "upstream_error" } });
      return;
    }
    recordUsage({ ts: new Date().toISOString(), model: jevModel,
      payer: extractPayer(req.get("payment-signature")), upstreamStatus: upstream.status, quotedUsd: await quoteJev(req.body) });
    res.status(200).json(data);
  } catch (error) {
    console.error("[jev] upstream request failed:", error instanceof Error ? error.name : "unknown");
    res.status(502).json({ error: { message: "Jev request failed", type: "upstream_error" } });
  }
});

if (embeddingsEnabled) app.post("/v1/embeddings", async (req, res) => {
  try {
    const upstream = await fetchEmbeddings(req.body);
    const raw = await upstream.text();
    recordEmbeddingData(req.body, raw, upstream.status, req.get("host") ?? "unknown");
    if (!upstream.ok) {
      let message = "NVIDIA returned HTTP " + upstream.status;
      try {
        const data = JSON.parse(raw);
        const detail = data.error?.message ?? data.message ?? data.detail;
        if (typeof detail === "string") message = detail.slice(0, 1000).replace(/Bearer\s+\S+|(?:sk-|nvapi-)[A-Za-z0-9_-]+/gi, "[redacted]");
      } catch { /* Non-JSON upstream responses retain the HTTP status explanation. */ }
      res.locals.embeddingFailure = { source: "upstream", reason: "upstream_http_" + upstream.status, message };
      res.status(upstream.status).type("application/json").send(raw); return;
    }
    res.status(200).type("application/json").send(raw);
  } catch (error) {
    console.error("[embeddings] upstream request failed:", error instanceof Error ? error.name : "unknown");
    res.locals.embeddingFailure = { source: "transport", reason: error instanceof Error ? error.name : "unknown", message: "Embeddings upstream connection failed" };
    res.status(502).json({ error: { message: "Embeddings request failed", type: "upstream_error" } });
  }
});
if (embeddingsEnabled) app.get("/api/v1/embeddings/stats", (req, res) => {
  const expected = config.embeddingStatsToken;
  const supplied = req.get("x-embedding-stats-token");
  if (!expected || supplied !== expected) { res.status(404).json({ error: { message: "Not found" } }); return; }
  res.setHeader("cache-control", "no-store");
  res.json({ object: "embedding_stats", model: embeddingModel, ...embeddingStats() });
});

// ---------------------------------------------------------------------------
// Public documents, rendered from the live catalog
// ---------------------------------------------------------------------------

function sendDoc(req: Request, res: Response, template: string, type: string): void {
  try {
    res.type(type).send(render(template, docVars(originOf(req))));
  } catch (error) {
    console.error(`[docs] failed to render ${template}:`, error);
    res.status(500).type("text/plain").send("document unavailable");
  }
}

app.get(["/", "/index.html"], (req, res) => sendDoc(req, res, "index.html", "html"));
app.get(["/developers", "/developers/"], (req, res) => sendDoc(req, res, "developers.html", "html"));

app.get("/AI-AGENTS.md", (req, res) =>
  sendDoc(req, res, "AI-AGENTS.md", "text/markdown; charset=utf-8"),
);

app.get("/robots.txt", (req, res) => sendDoc(req, res, "robots.txt", "text/plain; charset=utf-8"));

app.get("/sitemap.xml", (req, res) => sendDoc(req, res, "sitemap.xml", "application/xml"));

app.use("/examples/embeddings-to-chat", express.static(join(__dirname, "../examples/embeddings-to-chat"), {
  dotfiles: "deny",
  index: "index.html",
  maxAge: "1h",
}));

// Binary assets (favicon). Documents above are rendered, never served as files.
app.use(
  express.static(PUBLIC_DIR, {
    index: false,
    maxAge: "1d",
    setHeaders(res, filePath) {
      if (filePath.endsWith(".ico")) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      }
    },
  }),
);

// ---------------------------------------------------------------------------
// Free (discovery) endpoints
// ---------------------------------------------------------------------------

app.get("/v1/models", (req: Request, res: Response) => {
  const imageData = imageModels.flatMap((id) => Object.entries(imageRates[id]).map(([size, price]) => ({
    id, object: "model", created: 1700000000, owned_by: "mapleai", type: "image",
    size, pricing: { per_image: price, unit: "USD per image" },
  })));
  res.json({
    object: "list",
    data: [...catalog().map((m) => ({
      id: m.id,
      object: "model",
      created: 1700000000,
      owned_by: "openai",
      name: m.name,
      description: m.description,
      context_window: m.contextWindow,
      max_output: m.maxOutput,
      categories: m.categories,
      pricing: {
        input: m.pricing.input,
        output: m.pricing.output,
        unit: "USD per 1M tokens",
      },
    })), ...imageData, ...(embeddingsEnabled ? [{ id: embeddingModel, object: "model", created: 1700000000, owned_by: "nvidia", type: "embedding", pricing: { input: 0, output: 0, unit: "free" }, endpoint: "/v1/embeddings" }] : []), ...(jevEnabled ? [{ id: jevModel, object: "model", created: 1700000000,
      owned_by: "jev", type: "structured_decision", protocols: { primary: "systemone", supported: ["systemone"] },
      endpoint: "/jev", pricing: { input: jevPricePerMillion, output: 0, unit: "USD per 1M tokens" } }] : [])],
    default_price_per_request: config.defaultPrice,
    pricing_unit: "USD per 1M tokens (input/output) or per request",
    minimum_charge_usd: config.minChargeUsd,
    payment: {
      protocol: "x402",
      network: config.network,
      asset: chain.asset,
      asset_address: chain.assetAddress,
      pay_to: config.payTo,
      facilitator: config.facilitatorUrl,
    },
  });
});

app.get("/.well-known/x402", (req: Request, res: Response) => {
  const models = catalog();
  const resource = (method: string, path: string, extra: Record<string, unknown>) => ({
    method,
    path,
    description: CHAT_DESCRIPTION,
    pricedBy: "input tokens + max_tokens output, per-model $/1M-token rates",
    ...extra,
  });

  res.json({
    service: config.serviceName,
    summary: CATALOG_SUMMARY(),
    network: config.network,
    networkName: chain.networkName,
    asset: chain.asset,
    assetAddress: chain.assetAddress,
    payTo: config.payTo,
    facilitator: config.facilitatorMode === "cdp" ? CDP_FACILITATOR_URL : config.facilitatorUrl,
    contact: config.contactEmail,
    minimumChargeUsd: config.minChargeUsd,
    resources: [
      ...(nftEnabled ? Object.keys(nftNetworks).map((network) => ({ method: "GET", path: "/api/v1/" + network + "/nft/getNFTMetadata", description: nftDescription, price: nftPrice, pricedBy: "per request", exampleQuery: { contractAddress: nftExampleAddress } })) : []),
      resource("POST", "/v1/chat/completions", {}),
      resource("POST", "/api/v1/chat/completions", {}),
      {
        method: "POST",
        path: "/api/v1/responses",
        description: "OpenAI-compatible Responses API (alpha)",
        pricedBy: "input tokens + max_output_tokens, per-model $/1M-token rates",
      },
      {
        method: "POST",
        path: "/v1/responses",
        description: "OpenAI-compatible Responses API (alpha)",
        pricedBy: "input tokens + max_output_tokens, per-model $/1M-token rates",
      },
      ...(imagesEnabled ? [
        {
          method: "POST",
          path: "/api/v1/images/generations",
          description: "Image generation",
          pricedBy: "model, size and image count",
          exampleBody: imageExample,
        },
        {
          method: "POST",
          path: "/api/v1/images/image2image",
          description: "Image editing",
          pricedBy: "model, size and image count",
          exampleBody: imageEditExample,
        },
      ] : []),
      ...(embeddingsEnabled ? [{ method: "POST", path: "/v1/embeddings", description: "Free NVIDIA Nemotron embeddings", pricedBy: "free", exampleBody: { input: "Hello", input_type: "query", encoding_format: "float" } }] : []),
      ...(jevEnabled ? [{ method: "POST", path: "/jev", description: "Jev structured decisions",
        pricedBy: "input tokens plus payment overhead", exampleBody: jevExample }] : []),
      {
        method: "GET",
        path: "/v1/models",
        description: "Free model catalog with per-model pricing",
        price: "$0.00",
      },
    ],
    models: models.map((m) => ({
      id: m.id,
      name: m.name,
      contextWindow: m.contextWindow,
      maxOutput: m.maxOutput,
      pricing: { input: m.pricing.input, output: m.pricing.output, unit: "USD per 1M tokens" },
    })),
  });
});

app.get("/openapi.json", async (req: Request, res: Response) => {
  let overhead: number;
  try {
    overhead = await paymentOverheadUsd();
  } catch {
    res.status(503).json({ error: "gas quote unavailable" });
    return;
  }
  const models = catalog();
  const origin = originOf(req);
  const modelIds = models.map((m) => m.id);

  const modelPricing = {
    type: "dynamic",
    calculation: "input_tokens * input_rate + max_tokens * output_rate + settlement overhead, floored at the minimum charge",
    unit: "USD per 1M tokens",
    minimum_charge_usd: config.minChargeUsd,
    ...(config.network === "eip155:5042" ? { settlement_gas_estimate_usd: overhead } : { settlement_overhead_usd: overhead }),
    models: models.map((m) => ({
      id: m.id,
      input: m.pricing.input,
      output: m.pricing.output,
    })),
  };

  // Keep the discovery range tied to the live catalog and pricing settings.
  // This is the largest quote for a full context window plus the model's
  // advertised maximum output; individual requests are usually much smaller.
  const maxCatalogQuote = Math.max(
    ...models.map(
      (model) =>
        ((model.contextWindow * model.pricing.input + model.maxOutput * model.pricing.output) / 1_000_000) *
          config.priceMarkup +
        overhead,
    ),
    config.minChargeUsd,
  );

  const paymentInfo = {
    price: {
      mode: "dynamic",
      currency: "USD",
      min: Math.max(config.minChargeUsd, overhead).toFixed(6),
      max: maxCatalogQuote.toFixed(6),
    },
    protocols: [{ x402: {} }],
  };

  const chatBody = {
    required: true,
    content: {
      "application/json": {
        schema: {
          type: "object",
          required: ["model", "messages"],
          properties: {
            model: { type: "string", enum: modelIds },
            messages: {
              type: "array",
              description: "OpenAI chat messages",
              items: {
                type: "object",
                required: ["role"],
                properties: {
                  role: { type: "string", enum: ["system", "user", "assistant", "tool"] },
                  content: { type: "string" },
                },
              },
            },
            max_tokens: { type: "integer", default: config.outputTokenEstimate },
            temperature: { type: "number" },
            stream: { type: "boolean", default: false },
          },
        },
      },
    },
  };

  const responsesBody = {
    required: true,
    content: {
      "application/json": {
        schema: {
          type: "object",
          required: ["model", "input"],
          properties: {
            model: { type: "string", enum: modelIds },
            input: {
              oneOf: [
                { type: "string" },
                {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      role: { type: "string" },
                      content: { type: "string" },
                    },
                  },
                },
              ],
            },
            instructions: { type: "string" },
            max_output_tokens: { type: "integer", default: config.outputTokenEstimate },
            stream: { type: "boolean", default: false },
          },
        },
      },
    },
  };

  const usageSchema = {
    type: "object",
    properties: {
      prompt_tokens: { type: "integer" },
      completion_tokens: { type: "integer" },
      total_tokens: { type: "integer" },
    },
  };

  const chatCompletionSchema = {
    type: "object",
    required: ["id", "object", "created", "model", "choices"],
    properties: {
      id: { type: "string" },
      object: { type: "string", const: "chat.completion" },
      created: { type: "integer", description: "Unix timestamp in seconds" },
      model: { type: "string" },
      choices: {
        type: "array",
        items: {
          type: "object",
          required: ["index", "message", "finish_reason"],
          properties: {
            index: { type: "integer" },
            message: {
              type: "object",
              required: ["role", "content"],
              properties: {
                role: { type: "string", const: "assistant" },
                content: { type: ["string", "null"] },
                tool_calls: {
                  type: "array",
                  items: {
                    type: "object",
                    required: ["id", "type", "function"],
                    properties: {
                      id: { type: "string" },
                      type: { type: "string", const: "function" },
                      function: {
                        type: "object",
                        required: ["name", "arguments"],
                        properties: {
                          name: { type: "string" },
                          arguments: { type: "string" },
                        },
                      },
                    },
                  },
                },
              },
            },
            finish_reason: { type: ["string", "null"] },
          },
        },
      },
      usage: usageSchema,
    },
  };

  const responseSchema = {
    type: "object",
    required: ["id", "object", "created_at", "status", "model", "output", "output_text"],
    properties: {
      id: { type: "string" },
      object: { type: "string", const: "response" },
      created_at: { type: "integer", description: "Unix timestamp in seconds" },
      status: { type: "string", const: "completed" },
      model: { type: "string" },
      output: {
        type: "array",
        items: {
          oneOf: [
            {
              type: "object",
              required: ["id", "type", "status", "role", "content"],
              properties: {
                id: { type: "string" },
                type: { type: "string", const: "message" },
                status: { type: "string", const: "completed" },
                role: { type: "string", const: "assistant" },
                content: {
                  type: "array",
                  items: {
                    type: "object",
                    required: ["type", "text", "annotations"],
                    properties: {
                      type: { type: "string", const: "output_text" },
                      text: { type: "string" },
                      annotations: { type: "array", items: {} },
                    },
                  },
                },
              },
            },
            {
              type: "object",
              required: ["id", "type", "status", "call_id", "name", "arguments"],
              properties: {
                id: { type: "string" },
                type: { type: "string", const: "function_call" },
                status: { type: "string", const: "completed" },
                call_id: { type: "string" },
                name: { type: "string" },
                arguments: { type: "string" },
              },
            },
          ],
        },
      },
      output_text: { type: "string" },
      usage: {
        type: "object",
        properties: {
          input_tokens: { type: "integer" },
          output_tokens: { type: "integer" },
          total_tokens: { type: "integer" },
        },
      },
    },
  };

  const successfulResponse = (schema: Record<string, unknown>) => ({
    description: "Successful completion. Set stream: true for server-sent events.",
    content: {
      "application/json": { schema },
      "text/event-stream": {
        schema: { type: "string", description: "Server-sent events ending with data: [DONE]" },
      },
    },
  });

  const paidResponses = {
    "200": successfulResponse(chatCompletionSchema),
    "400": { description: "Unknown or missing model" },
    "402": {
      description: "Payment required",
      headers: {
        "PAYMENT-REQUIRED": {
          schema: { type: "string" },
          description: "Base64-encoded x402 payment requirements (price, network, asset, payTo)",
        },
      },
    },
  };
  const responsesApiResponses = {
    ...paidResponses,
    "200": successfulResponse(responseSchema),
  };

  const imageResponse = {
    "200": { description: "Generated images", content: { "application/json": { schema: {
      type: "object", required: ["data"], properties: {
        created: { type: "integer" }, data: { type: "array", items: { type: "object", properties: {
          url: { type: "string", format: "uri" }, b64_json: { type: "string" },
        } } },
      },
    } } } },
    "400": { description: "Invalid image request" },
    "402": paidResponses["402"],
    "502": { description: "Image upstream failed" },
  };
  const imageBody = (edit: boolean) => ({ required: true, content: { "application/json": { example: edit ? imageEditExample : imageExample, schema: {
    type: "object", required: edit ? ["model", "size", "prompt", "image"] : ["model", "size", "prompt"],
    properties: { model: { type: "string", enum: imageModels }, size: { type: "string", example: imageExampleSize, description: "A listed size for the selected model" },
      n: { type: "integer", minimum: 1, maximum: 4, default: 1 }, prompt: { type: "string", example: imageExample.prompt, maxLength: 4000 },
      ...(edit ? { image: { type: "string", example: imageEditExample.image, description: "PNG, JPEG or WebP base64 data URI, maximum 10 MB" } } : {}),
    },
  } } } });

  res.json({
    openapi: "3.1.0",
    info: {
      title: config.serviceName,
      version: "1.0.0",
      description:
        `Pay-per-request API access via x402 on ${chain.networkName}. ` +
        `${models.length} GPT models, ${imageModels.length} image models` +
        (jevEnabled ? ", and Jev structured decisions" : "") + "; no accounts or client API keys.",
      contact: {
        name: config.serviceName,
        email: config.contactEmail,
        url: origin,
      },
      license: { name: "Proprietary" },
      "x-payment": {
        protocol: "x402",
        network: config.network,
        asset: chain.asset,
        assetAddress: chain.assetAddress,
        payTo: config.payTo,
        facilitator: config.facilitatorMode === "cdp" ? CDP_FACILITATOR_URL : config.facilitatorUrl,
        minimumChargeUsd: config.minChargeUsd,
      },
    },
    servers: [{ url: origin }],
    "x-discovery": {
      "well-known": `${origin}/.well-known/x402`,
      llms: `${origin}/llms.txt`,
      agents: `${origin}/AI-AGENTS.md`,
    },
    components: {
      securitySchemes: {
        x402: {
          type: "apiKey",
          in: "header",
          name: "PAYMENT-SIGNATURE",
          description:
            "x402 payment payload. Request the resource once to receive HTTP 402 with the " +
            "exact price in the PAYMENT-REQUIRED header, sign the USDC transfer, then retry " +
            "with the signed payload in PAYMENT-SIGNATURE.",
        },
      },
    },
    paths: {
      ...(nftEnabled ? Object.fromEntries(Object.keys(nftNetworks).map((network) => ["/api/v1/" + network + "/nft/getNFTMetadata", { get: {
        summary: "Get NFT contract metadata", description: nftDescription + ". Returns on-chain contract metadata; optional fields are null when unsupported. Does not enumerate wallet NFTs or fetch off-chain token metadata.",
        operationId: "getNFTMetadata_" + network.replace(/-/g, "_"), security: [{ x402: [] }],
        "x-payment-info": { price: { mode: "fixed", amount: 0.002, currency: "USD" }, protocols: [{ x402: {} }] },
        parameters: [{ name: "contractAddress", in: "query", required: true, schema: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" }, example: nftExampleAddress }],
        responses: { "200": { description: "On-chain NFT contract metadata" }, "400": { description: "Invalid contract address" }, "402": paidResponses["402"], "404": { description: "Contract not found" }, "502": { description: "Infura unavailable" } },
      } }])) : {}),
      ...(imagesEnabled ? {
        "/api/v1/images/generations": { post: { summary: "Generate images", operationId: "generateImages", security: [{ x402: [] }],
          "x-payment-info": { price: { mode: "dynamic", currency: "USD" }, protocols: [{ x402: {} }] },
          "x-pricing": { unit: "USD per image", models: imageRates }, requestBody: imageBody(false), responses: imageResponse } },
        "/api/v1/images/image2image": { post: { summary: "Edit an image", operationId: "editImage", security: [{ x402: [] }],
          "x-payment-info": { price: { mode: "dynamic", currency: "USD" }, protocols: [{ x402: {} }] },
          "x-pricing": { unit: "USD per image", models: imageRates }, requestBody: imageBody(true), responses: imageResponse } },
      } : {}),
      ...(embeddingsEnabled ? { "/v1/embeddings": { post: { summary: "Create free embeddings", operationId: "createEmbeddings", security: [], description: `Free NVIDIA Nemotron embeddings. The endpoint uses ${embeddingModel}; model is optional.`, requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["input"], properties: { model: { type: "string", enum: [embeddingModel], description: "Optional; defaults to the only model served by this endpoint." }, input: { oneOf: [{ type: "string" }, { type: "array", minItems: 1, maxItems: 128, items: { type: "string" } }] }, input_type: { type: "string", enum: ["query", "passage"] }, encoding_format: { type: "string", enum: ["float", "base64"] } } }, example: { input: "Hello", input_type: "query", encoding_format: "float" } } } }, responses: { "200": { description: "Embedding vectors" }, "400": { description: "Invalid request" }, "502": { description: "NVIDIA upstream failed" } } } } } : {}),
      ...(jevEnabled ? { "/jev": { post: { summary: "Run Jev structured decision", operationId: "runJev",
        description: "SystemOne protocol for jev-latest. Returns structured answers, not chat text.",
        security: [{ x402: [] }],
        "x-payment-info": { price: { mode: "dynamic", currency: "USD" }, protocols: [{ x402: {} }] },
        "x-pricing": { unit: "USD per 1M tokens", input: jevPricePerMillion, output: 0 },
        requestBody: { required: true, content: { "application/json": { example: jevExample, schema: jevSchema } } },
        responses: { "200": { description: "Structured answers", content: { "application/json": {
          example: { model: "jev-1.13.0", answers: { billing: { type: "noul", noul: 0.98 } },
            usage: { input_tokens: 282, output_tokens: 20 } },
        } } }, "400": { description: "Invalid request" },
          "402": paidResponses["402"], "502": { description: "Upstream unavailable" } },
      } } } : {}),
      "/v1/chat/completions": {
        post: {
          summary: "Create chat completion",
          description: CHAT_DESCRIPTION,
          operationId: "createChatCompletion",
          security: [{ x402: [] }],
          "x-payment-info": paymentInfo,
          "x-pricing": modelPricing,
          requestBody: chatBody,
          responses: paidResponses,
        },
      },
      "/api/v1/chat/completions": {
        post: {
          summary: "Create chat completion (agent alias)",
          description: `${CHAT_DESCRIPTION}. Alias of /v1/chat/completions for agent crawlers.`,
          operationId: "createChatCompletionAlias",
          security: [{ x402: [] }],
          "x-payment-info": paymentInfo,
          "x-pricing": modelPricing,
          requestBody: chatBody,
          responses: paidResponses,
        },
      },
      "/api/v1/responses": {
        post: {
          summary: "Create a model response",
          description:
            "OpenAI-compatible Responses API (alpha). Translated to a chat completion upstream.",
          operationId: "createResponse",
          security: [{ x402: [] }],
          "x-payment-info": paymentInfo,
          "x-pricing": modelPricing,
          requestBody: responsesBody,
          responses: responsesApiResponses,
        },
      },
      "/v1/responses": {
        post: {
          summary: "Create a model response (short path)",
          description:
            "Alias of /api/v1/responses. OpenAI-compatible Responses API (alpha), translated to a chat completion upstream.",
          operationId: "createResponseAlias",
          security: [{ x402: [] }],
          "x-payment-info": paymentInfo,
          "x-pricing": modelPricing,
          requestBody: responsesBody,
          responses: responsesApiResponses,
        },
      },
      "/v1/models": {
        get: {
          summary: "List available models",
          description: "Free. Returns every sellable GPT model with live pricing.",
          operationId: "listModels",
          // Free endpoint: excluded from x402 probing.
          security: [],
          responses: { "200": { description: "List of models" } },
        },
      },
      "/.well-known/x402": {
        get: {
          summary: "x402 resource manifest",
          description: "Free. Machine-readable x402 discovery document.",
          operationId: "x402Discovery",
          security: [],
          responses: { "200": { description: "x402 discovery document" } },
        },
      },
      "/health": {
        get: {
          summary: "Service health",
          description: "Free. Liveness probe.",
          operationId: "health",
          security: [],
          responses: { "200": { description: "Service status" } },
        },
      },
    },
  });
});

app.get("/llms.txt", (req: Request, res: Response) => {
  const origin = originOf(req);
  const models = catalog();
  const baseUrl = `${origin}/v1`;

  res.type("text/plain; charset=utf-8").send(
    [
      `# ${config.serviceName}`,
      "",
      `> Pay-per-use GPT models via x402 micropayments on ${chain.networkName}.`,
      "",
      `GPT API access with pay-per-request pricing: ${models.length} GPT models behind one`,
      "OpenAI-compatible endpoint. No accounts, no subscriptions, no API keys — an agent pays",
      `per request in ${chain.asset} over the x402 protocol.`,
      "",
      "## Payment",
      "",
      `- Protocol: x402`,
      `- Network: ${config.network} (${chain.networkName})`,
      `- Currency: ${chain.asset} (${chain.assetAddress})`,
      `- Recipient: ${config.payTo}`,
      `- Facilitator: ${config.facilitatorUrl}`,
      `- Minimum charge: $${config.minChargeUsd.toFixed(4)} per paid request (about $0.002 rounded)`,
      `- Contact: ${config.contactEmail}`,
      "",
      "## Endpoints",
      "",
      `POST ${baseUrl}/chat/completions`,
      "  OpenAI-compatible chat completions (paid).",
      "  Returns HTTP 402 with a PAYMENT-REQUIRED header when payment is required.",
      config.network === "eip155:5042"
        ? "  Price = input_tokens * input_rate + max_tokens * output_rate + estimated Arc settlement gas."
        : "  Price = input_tokens * input_rate + max_tokens * output_rate.",
      "",
      `POST ${origin}/api/v1/chat/completions`,
      "  Alias of the above, for agent crawlers (paid).",
      "",
      `POST ${origin}/api/v1/responses`,
      "  OpenAI-compatible Responses API, alpha (paid).",
      "",
      `GET ${baseUrl}/models`,
      "  List all available models with pricing (free).",
      ...(imagesEnabled ? [
        "",
        "POST " + origin + "/api/v1/images/generations",
        "  Generate images (paid; per image and size).",
        "POST " + origin + "/api/v1/images/image2image",
        "  Edit a PNG, JPEG or WebP base64 data URI (paid; maximum 10 MB).",
      ] : []),
     ...(jevEnabled ? ["", "POST " + origin + "/jev", "  Jev structured decisions ($" + jevPricePerMillion?.toFixed(2) + "/1M input tokens plus payment overhead). Send model=jev-latest, state and named questions with type and instructions."] : []),
      ...(embeddingsEnabled ? ["", "POST " + origin + "/v1/embeddings", "  Free NVIDIA embeddings with nvidia/nemotron-3-embed-1b."] : []),
      ...(nftEnabled ? ["", "GET " + origin + "/api/v1/{chainNetwork}/nft/getNFTMetadata?contractAddress=0x...", "  On-chain NFT contract metadata via Infura; $0.002 USDC per request.", "  Networks: " + Object.keys(nftNetworks).join(", ") + ". Returns name, symbol, contractURI and ERC interface support; unsupported fields are null."] : []),
      "",
      "## Available Models",
      "",
      ...models.map(
        (m) =>
          `- ${m.id}\n  ${m.name}: $${money(m.pricing.input)}/1M in, $${money(m.pricing.output)}/1M out, ` +
          `${compactTokens(m.contextWindow)} context`,
      ),
      "",
      ...(imagesEnabled ? [
        "## Image Models",
        "",
        ...imageModels.flatMap((id) => Object.entries(imageRates[id]).map(([size, price]) =>
          "- " + id + " (" + size + "): $" + price.toFixed(4) + " per image",
        )),
        "",
        "Send model, size, prompt and optional n (1-4). Edits also require image as a base64 data URI.",
        "The x402 challenge includes payment overhead. Successful responses contain data[].url or data[].b64_json.",
        "",
      ] : []),
      ...(jevEnabled ? ["## Jev", "", "- jev-latest: $" + jevPricePerMillion?.toFixed(2) + "/1M input tokens; output tokens free",
        "- SystemOne only. POST /jev with model, state and named questions; each question needs type (noul, choice or score) and instructions. Read answers from the response.", ""] : []),
      "## Usage",
      "",
      `1. Make a request to ${baseUrl}/chat/completions without payment`,
      "2. Receive HTTP 402 with a PAYMENT-REQUIRED header describing price and payment options",
      "3. Sign the transfer authorization with your wallet (x402 client libraries do this automatically)",
      "4. Retry the request with the PAYMENT-SIGNATURE header",
      "5. Receive the completion",
      "",
      "## Discovery",
      "",
      `${origin}/.well-known/x402 - x402 discovery document`,
      `${origin}/openapi.json - OpenAPI 3.1 specification`,
      `${origin}/AI-AGENTS.md - integration guide for agents`,
      `${origin}/llms.txt - this file`,
      "",
    ].join("\n"),
  );
});

app.get("/health", (req: Request, res: Response) => {
  res.json({
    status: "ok",
    service: config.serviceName,
    network: config.network,
    networkName: chain.networkName,
    models: catalog().length,
    minInputPriceUsd: minInputPrice(),
    maxContextWindow: maxContextWindow(),
    upstreamHost: new URL(config.upstreamBaseUrl).host,
    upstreamConfigured: config.upstreamApiKey.length > 0,
    facilitator: config.facilitatorMode === "cdp" ? CDP_FACILITATOR_URL : config.facilitatorUrl,
    time: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Unknown API paths get JSON rather than Express's HTML error page. */
app.use((req: Request, res: Response, next: unknown) => {
  if (req.path.startsWith("/v1/") || req.path.startsWith("/api/")) {
    res.status(404).json({
      error: { message: `unknown endpoint: ${req.method} ${req.path}`, type: "invalid_request" },
    });
    return;
  }
  (next as () => void)();
});

app.use((err: unknown, _req: Request, res: Response, _next: unknown) => {
  console.error("[server] error:", err);
  if (!res.headersSent) {
    res.status(400).json({ error: { message: "bad request", type: "invalid_request" } });
  }
});

app.listen(config.port, () => {
  console.log(`[server] ${config.serviceName} listening on http://localhost:${config.port}`);
  console.log(`[server] network=${config.network} payTo=${config.payTo}`);
  console.log(`[server] upstream=${config.upstreamBaseUrl} models=${catalog().length}`);
});
