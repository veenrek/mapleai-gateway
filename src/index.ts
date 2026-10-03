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
import { canonicalModelId, isModelEnabled, listModels, pricingForModel, upstreamModelId } from "./models.js";
import { estimateOutputTokens, quotePrice, quoteBreakdown } from "./pricing.js";
import { paymentOverheadUsd } from "./gas.js";
import { actualCostUsd, extractPayer, parseUsage, parseUsageFromSse, recordUsage } from "./ledger.js";
import { paymentEventMiddleware } from "./payment-events.js";
import { prepaidBypassMiddleware } from "./prepaid-bypass.js";
import { fetchUpstreamChat } from "./upstream.js";
import { fetchImage, imageModels, imageRates, imagesEnabled, quoteImage, validateImage, type ImageKind, type ImageRequest } from "./images.js";
import { fetchJev, jevEnabled, jevModel, jevPricePerMillion, quoteJev, recordJevData, validateJev } from "./jev.js";
import { fetchXSearch, quoteXSearch, validateXSearch, xSearchBasePriceUsd, xSearchEnabled, xSearchModel, xSearchPerResultUsd, xSearchWebPriceUsd } from "./xsearch.js";
import { digestBaseUsd, digestMediaUsd, digestPerHandleUsd, factcheckBaseUsd, factcheckPerSourceUsd, handleXDigest, handleXFactcheck, handleXSentiment, quoteXDigest, quoteXFactcheck, quoteXSentiment, sentimentBaseUsd, sentimentPerDayUsd, sentimentPerExampleUsd, validateXDigest, validateXFactcheck, validateXSentiment } from "./xintel.js";
import { agentsEnginePricing, agentsExecuteEnabled, codeExecEnabled, codeExecMaxPerTask, codeExecPerCallUsd, handleAgentsExecute, quoteAgentsExecute, validateAgentsExecute } from "./agents.js";
import { freeGptOssEnabled, freeGptOssModel, freeQuotaSnapshot, handleFreeGptOssChat } from "./free-gptoss.js";
import {
  embeddingModel,
  embeddingRequestSchema,
  embeddingNextEndpoint,
  embeddingNextHint,
  embeddingValidationErrorSchema,
  embeddingsEnabled,
  fetchEmbeddings,
  validateEmbedding,
} from "./embeddings.js";
import { embeddingStats, recordEmbeddingData, trackEmbeddingRequest } from "./embedding-stats.js";
import {
  fetchSpeech,
  fetchTranscription,
  quoteSpeech,
  quoteTranscription,
  speechEnabled,
  speechModels,
  speechPriceUsd,
  transcriptionModels,
  transcriptionPriceUsd,
  transcriptionsEnabled,
  validateSpeech,
  validateTranscription,
  type SpeechRequest,
  type TranscriptionRequest,
} from "./audio.js";
import {
  issuePrepaidCode,
  normalizeAutoPurchase,
  prepaidCodeExample,
  prepaidCodeInputSchema,
  prepaidCodeModels,
  sellablePrepaidModels,
  prepaidCodeOutputExample,
  prepaidCodesEnabled,
  prepaidApiBaseUrl,
  prepaidModelOffers,
  prepaidStatusUrl,
  quotePrepaidCode,
  validatePrepaidCodePurchase,
} from "./prepaid-codes.js";
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
if (embeddingsEnabled) app.post("/v1/embeddings", (req, res, next) => { trackEmbeddingRequest(req, res, embeddingModel); next(); });
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
// Prepaid buyer keys (Bearer oms_buy_*) are forwarded to the admin prepaid API
// before the x402 paywall; requests without such a key continue as pay-per-request.
app.use(prepaidBypassMiddleware);

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

const audioModelCount = () => (speechEnabled ? speechModels.length : 0) + (transcriptionsEnabled ? transcriptionModels.length : 0);
const CATALOG_SUMMARY = () => `${catalog().length} GPT models, ${imageModels.length} image models` +
  (audioModelCount() ? `, ${audioModelCount()} audio models` : "") +
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

const bazaarIconUrl = config.publicBaseUrl ? config.publicBaseUrl + "/favicon.ico" : undefined;

/** Bazaar card metadata proven by Cluster Protocol: serviceName/tags/iconUrl next to info+schema. */
function bazaarCard(discovery: ReturnType<typeof declareDiscoveryExtension>, tags: string[]) {
  const inner = (discovery as { bazaar?: Record<string, unknown> }).bazaar ?? {};
  return {
    ...discovery,
    bazaar: {
      serviceName: config.serviceName,
      ...(tags.length > 0 ? { tags } : {}),
      ...(bazaarIconUrl ? { iconUrl: bazaarIconUrl } : {}),
      ...inner,
    },
  };
}

/** Every paid route shares one pricing rule; only the discovery shape differs. */
function paidRoute(description: string, discovery: ReturnType<typeof declareDiscoveryExtension>, price: DynamicPrice = quotedPrice, includeQuote = true, upfront = false, tags: string[] = [], mimeType = "application/json") {
  return {
    accepts: {
      scheme: "exact",
      price,
      network: config.network,
      payTo: config.payTo,
      maxTimeoutSeconds: 120,
      // Solana blockhashes outlive slow upstream calls (image generation takes
      // 40-100s), so settlement after the handler fails with BlockhashNotFound.
      // Upfront settles right after verification, before the work starts.
      ...(upfront && config.network.startsWith("solana:") ? { extra: { paymentFlow: "upfront" } } : {}),
    },
    description,
    mimeType,
    extensions: { ...(includeQuote ? { quote: {} } : {}), ...bazaarCard(discovery, tags) },
  };
}

const CHAT_DESCRIPTION =
  "OpenAI-compatible chat completion, priced by counted input tokens + max output tokens at per-model rates";
const CHAT_TAGS = ["AI", "inference", "LLM", "chat"];

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

const xSearchDiscovery = declareDiscoveryExtension({
  input: { query: "new x402 facilitator launches this week", max_results: 10 },
  inputSchema: { type: "object", required: ["query"], properties: {
    query: { type: "string", description: "What to look for on X/Twitter, 1-2000 characters" },
    max_results: { type: "integer", minimum: 1, maximum: 25, default: 10, description: "Maximum posts cited" },
    include_web: { type: "boolean", default: false, description: "Also run a web search alongside X" },
    instructions: { type: "string", description: "Optional extra instructions for the search agent" },
  } },
  bodyType: "json",
  output: { example: { object: "response", output_text: "...", citations: ["https://x.com/user/status/123"],
    usage: { input_tokens: 1200, output_tokens: 300 } } },
});

const xDigestExample = { handles: ["base", "jessepollak", "brian_armstrong"], hours_back: 24, max_posts_per_handle: 3 };
const xDigestSchema = { type: "object", required: ["handles"], properties: {
  handles: { type: "array", minItems: 1, maxItems: 20, items: { type: "string", pattern: "^@?[A-Za-z0-9_]{1,15}$" }, description: "X handles to monitor (with or without @)" },
  hours_back: { type: "integer", minimum: 1, maximum: 168, default: 24, description: "Look-back window in hours" },
  max_posts_per_handle: { type: "integer", minimum: 1, maximum: 5, default: 3 },
  include_media: { type: "boolean", default: false, description: "Also analyze images inside the fetched posts" },
} };
const xDigestDiscovery = declareDiscoveryExtension({
  input: xDigestExample, inputSchema: xDigestSchema, bodyType: "json",
  output: { example: { object: "x.digest", window_hours: 24,
    handles: [{ handle: "base", silent: false, themes: ["gas upgrade"], posts: [{ url: "https://x.com/base/status/123", summary: "...", likes: 4200, reposts: 890 }] }] } },
});

const xSentimentExample = { topic: "x402 protocol", hours_back: 24, max_examples: 5, min_engagement: 10 };
const xSentimentSchema = { type: "object", required: ["topic"], properties: {
  topic: { type: "string", maxLength: 200, description: "Token, project or narrative to assess" },
  hours_back: { type: "integer", minimum: 1, maximum: 168, default: 24 },
  max_examples: { type: "integer", minimum: 1, maximum: 10, default: 5, description: "Evidence posts in the answer; drives the price" },
  min_engagement: { type: "integer", minimum: 0, default: 0, description: "When > 0, keyword searches use min_faves:N to skip low-engagement noise" },
} };
const xSentimentDiscovery = declareDiscoveryExtension({
  input: xSentimentExample, inputSchema: xSentimentSchema, bodyType: "json",
  output: { example: { object: "x.sentiment", topic: "x402 protocol", verdict: "bullish", score: 0.6,
    distribution: { bullish: 14, bearish: 3, neutral: 5 }, posts_evaluated: 22, drivers: ["agent payments momentum"],
    examples: [{ url: "https://x.com/user/status/123", stance: "bullish", snippet: "...", likes: 420 }] } },
});

const xFactcheckExample = { claim: "Tether is bringing USDT back to the Bitcoin network", max_sources: 6, days_back: 7 };
const xFactcheckSchema = { type: "object", required: ["claim"], properties: {
  claim: { type: "string", maxLength: 1000, description: "The statement to verify" },
  max_sources: { type: "integer", minimum: 1, maximum: 10, default: 6, description: "Max evidence items per side; drives the price" },
  days_back: { type: "integer", minimum: 1, maximum: 30, default: 7, description: "How far back to look" },
} };
const xFactcheckDiscovery = declareDiscoveryExtension({
  input: xFactcheckExample, inputSchema: xFactcheckSchema, bodyType: "json",
  output: { example: { object: "x.factcheck", claim: "...", verdict: "confirmed", confidence: "high", summary: "...",
    evidence_for: [{ url: "https://x.com/user/status/123", source_type: "x", note: "..." }], evidence_against: [] } },
});

const speechExample = { model: speechModels[0] ?? "tts-1", input: "Hello from MapleAI", voice: "alloy", response_format: "wav" };
const speechDiscovery = declareDiscoveryExtension({
  input: speechExample,
  inputSchema: { type: "object", required: ["model", "input"], properties: {
    model: { type: "string", enum: speechModels, description: "tts-1 = fast Gemini Flash-Lite, tts-1-hd = fuller Gemini Flash, orpheus-english/orpheus-arabic = emotive Groq Orpheus (en voices autumn/diana/hannah/austin/daniel/troy, ar voices fahad/sultan/noura/lulwa/aisha/abdullah; emotion tags like [laughs] supported)" },
    input: { type: "string", description: "Text to synthesize, 1-5000 characters" },
    voice: { type: "string", description: "Voice preset (alloy, echo, fable, onyx, nova, shimmer…) or a Gemini voice name; default alloy" },
    response_format: { type: "string", enum: ["wav"], default: "wav" },
    speed: { type: "number", minimum: 0.25, maximum: 4 },
  } },
  bodyType: "json",
  output: { example: { audio: "binary WAV stream (audio/wav)", format: "RIFF/WAVE 24 kHz mono" } },
});

const transcriptionDiscovery = declareDiscoveryExtension({
  input: { model: "whisper-1", file: "data:audio/mpeg;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA", response_format: "json" },
  inputSchema: { type: "object", required: ["file"], properties: {
    model: { type: "string", enum: transcriptionModels, default: "whisper-1" },
    file: { type: "string", description: "Audio (mp3, wav, m4a, ogg, flac, webm) as base64 or data URI, max 25 MB; multipart/form-data with a file field works too" },
    language: { type: "string", description: "Optional ISO 639-1 hint" },
    response_format: { type: "string", enum: ["json", "text", "verbose_json", "srt", "vtt"], default: "json", description: "verbose_json (word timestamps) / srt / vtt require whisper-large-v3 or whisper-large-v3-turbo (groq backend)" },
  } },
  bodyType: "json",
  output: { example: { text: "Hello from MapleAI" } },
});

const agentsExample = { model: "agents/oss-20b", task: "What is the population of France divided by 7?", max_steps: 6 };
const agentsDiscovery = declareDiscoveryExtension({
  input: agentsExample,
  inputSchema: { type: "object", required: ["task"], properties: {
    model: { type: "string", enum: ["agents/oss-20b", "agents/gpt-6-sol"], description: "Execution engine: cheap oss-20b or premium gpt-6-sol" },
    task: { type: "string", description: "Natural language task for the agent" },
    context: { type: "string", description: "Additional data or constraints" },
    max_steps: { type: "integer", minimum: 1, maximum: 20, default: 8, description: "Charged ceiling of reasoning/tool steps" },
    tools: { type: "array", items: { type: "string", enum: codeExecEnabled ? ["calculator", "fetch_url", "web_search", "data_analysis", "code_exec"] : ["calculator", "fetch_url", "web_search", "data_analysis"] }, description: "Allowed tools, defaults to the enabled set" + (codeExecEnabled ? "; code_exec runs sandboxed python/javascript/typescript, $0.002 per call, max 3 per task" : "; code_exec disabled on this deployment") },
    stream: { type: "boolean", default: false, description: "When true, send SSE events: open, step per completed step, done with the full payload" },
  } },
  bodyType: "json",
  output: { example: { object: "agent.execution", model: "agents/oss-20b", status: "completed", steps_executed: 2,
    steps: [{ n: 1, thought: "Need the population", action: "tool", tool_call: { name: "fetch_url", args: { url: "https://example.com/france" } }, tool_result: "68 million" }],
    output: { result: "About 9.7 million", sources: [{ url: "https://example.com/france" }] },
    usage: { input_tokens: 4100, output_tokens: 260, tools_invoked: 1, steps_executed: 2, cost_usd: 0,
      charge: { base_usd: 0.002, step_usd: 0.0005, steps_charged_ceiling: 6, charged_ceiling_usd: 0.005 } } } },
});

if (embeddingsEnabled) app.post("/v1/embeddings", validateEmbedding);

const PAID_ROUTES = {
  ...(nftEnabled ? Object.fromEntries(Object.keys(nftNetworks).map((network) => [
    "GET /api/v1/" + network + "/nft/getNFTMetadata",
    paidRoute(nftDescription, declareDiscoveryExtension({
      input: { contractAddress: nftExampleAddress },
      inputSchema: { type: "object", required: ["contractAddress"], properties: { contractAddress: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" } } },
      output: { example: { object: "nft_contract_metadata", chainNetwork: network, contractAddress: nftExampleAddress, name: "BoredApeYachtClub", symbol: "BAYC", tokenType: "ERC721" } },
    }), async () => nftPrice, false, false, ["NFT", "metadata", "crypto"]),
  ])) : {}),
  "POST /v1/chat/completions": paidRoute(CHAT_DESCRIPTION, chatDiscovery, quotedPrice, true, false, CHAT_TAGS),
  "POST /api/v1/chat/completions": paidRoute(CHAT_DESCRIPTION, chatDiscovery, quotedPrice, true, false, CHAT_TAGS),
  "POST /api/v1/responses": paidRoute(
    "OpenAI-compatible Responses API (alpha), translated to chat completions upstream",
    responsesDiscovery, quotedPrice, true, false, CHAT_TAGS,
  ),
  "POST /v1/responses": paidRoute(
    "OpenAI-compatible Responses API (alpha), translated to chat completions upstream",
    responsesDiscovery, quotedPrice, true, false, CHAT_TAGS,
  ),
  ...(imagesEnabled ? {
    "POST /api/v1/images/generations": paidRoute("Generate images, priced per image and size", imageDiscovery, (context) => quoteImage(requestBody(context)), false, true, ["AI", "image", "generation"]),
    "POST /api/v1/images/image2image": paidRoute("Edit an image, priced per image and size", editDiscovery, (context) => quoteImage(requestBody(context)), false, true, ["AI", "image", "editing"]),
  } : {}),
  ...(speechEnabled ? {
    "POST /v1/audio/speech": paidRoute("Text-to-speech synthesis, priced per request", speechDiscovery, (context) => quoteSpeech(requestBody(context)), false, false, ["AI", "audio", "tts", "speech"], "audio/wav"),
  } : {}),
  ...(transcriptionsEnabled ? {
    "POST /v1/audio/transcriptions": paidRoute("Audio transcription (speech-to-text), priced per request; multipart file upload or JSON base64", transcriptionDiscovery, (context) => quoteTranscription(requestBody(context)), false, false, ["AI", "audio", "stt", "transcription"]),
  } : {}),
  ...(jevEnabled ? { "POST /jev": paidRoute("Jev structured decisions via SystemOne, priced by input tokens",
    jevDiscovery, (context) => quoteJev(requestBody(context) as { state: unknown; questions: unknown }), false, false, ["AI", "classification", "structured", "decisions"]) } : {}),
  ...(xSearchEnabled ? { "POST /v1/x/search": paidRoute(`Live X/Twitter search via Grok x_search, summarized answer with direct post citations; $${xSearchBasePriceUsd} + $${xSearchPerResultUsd} per requested max_result (+$${xSearchWebPriceUsd} with include_web)`,
    xSearchDiscovery, (context) => quoteXSearch(requestBody(context) as Parameters<typeof quoteXSearch>[0]), false, false, ["AI", "search", "x", "twitter", "social"]) } : {}),
  ...(xSearchEnabled ? { "POST /v1/x/digest": paidRoute(`Digest of specific X handles over a look-back window: key posts with links and engagement, silent handles marked; $${digestBaseUsd} + $${digestPerHandleUsd} per handle`,
    xDigestDiscovery, (context) => quoteXDigest(requestBody(context) as Parameters<typeof quoteXDigest>[0]), false, false, ["AI", "search", "x", "twitter", "digest", "monitoring"]) } : {}),
  ...(xSearchEnabled ? { "POST /v1/x/sentiment": paidRoute("X sentiment for a token, project or narrative: verdict, score, distribution, drivers and evidence posts",
    xSentimentDiscovery, (context) => quoteXSentiment(requestBody(context) as Parameters<typeof quoteXSentiment>[0]), false, false, ["AI", "search", "x", "twitter", "sentiment", "analytics"]) } : {}),
  ...(xSearchEnabled ? { "POST /v1/x/factcheck": paidRoute("Factcheck a claim against X posts and web sources: verdict, confidence and evidence for/against",
    xFactcheckDiscovery, (context) => quoteXFactcheck(requestBody(context) as Parameters<typeof quoteXFactcheck>[0]), false, false, ["AI", "search", "x", "twitter", "factcheck", "verification"]) } : {}),
  ...(agentsExecuteEnabled ? { "POST /v1/agents/execute": paidRoute("Autonomous agent execution (multi-step reasoning + tools). Engines: cheap agents/oss-20b or premium agents/gpt-6-sol; stream=true streams SSE step events. Ceiling = engine base + max_steps x step" + (codeExecEnabled ? " + code_exec calls ($0.002 each, max 3 per task)" : "") + " (charged_ceiling_usd).",
    agentsDiscovery, (context) => quoteAgentsExecute(requestBody(context) as Parameters<typeof quoteAgentsExecute>[0]), false, true, ["AI", "agents", "automation", "tools"]) } : {}),
  ...(prepaidCodesEnabled ? {
    "POST /prepaid/codes": paidRoute(
      "Buy a prepaid API code for one GPT model and a token budget",
      declareDiscoveryExtension({
        input: prepaidCodeExample,
        inputSchema: prepaidCodeInputSchema,
        bodyType: "json",
        output: { example: prepaidCodeOutputExample },
      }),
      (context) => quotePrepaidCode(requestBody(context) as { model: string; tokens: number }),
      false,
      false,
      ["AI", "prepaid", "credits"],
    ),
    "POST /prepaid/codes/auto": paidRoute(
      "One-shot prepaid tap: empty body buys a 100000-token openai/gpt-6-luna key",
      declareDiscoveryExtension({
        input: {},
        inputSchema: { type: "object", properties: { model: { type: "string", enum: sellablePrepaidModels }, tokens: { type: "integer" } } },
        bodyType: "json",
        output: { example: prepaidCodeOutputExample },
      }),
      (context) => quotePrepaidCode(normalizeAutoPurchase(requestBody(context))),
      false,
      false,
      ["AI", "prepaid", "credits"],
    ),
  } : {}),
};

app.use(paymentMiddleware(PAID_ROUTES, resourceServer));

if (imagesEnabled) {
  app.post("/api/v1/images/generations", validateImage("generation"));
  app.post("/api/v1/images/image2image", validateImage("edit"));
}
if (speechEnabled) app.post("/v1/audio/speech", validateSpeech);
if (transcriptionsEnabled) {
  const audioUpload = express.raw({ type: ["multipart/form-data"], limit: "25mb" });
  app.post("/v1/audio/transcriptions", audioUpload, validateTranscription);
}
if (jevEnabled) app.post("/jev", validateJev);
if (xSearchEnabled) app.post("/v1/x/search", validateXSearch);
if (xSearchEnabled) {
  app.post("/v1/x/digest", validateXDigest);
  app.post("/v1/x/sentiment", validateXSentiment);
  app.post("/v1/x/factcheck", validateXFactcheck);
}
if (agentsExecuteEnabled) app.post("/v1/agents/execute", validateAgentsExecute);
async function handlePrepaidCodePurchase(req: Request, res: Response): Promise<void> {
  try {
    const purchase = await issuePrepaidCode(
      req.body as { model: string; tokens: number },
      config.network,
      req.get("payment-signature") ?? req.get("x-payment") ?? undefined,
    );
    res.setHeader("Cache-Control", "no-store");
    res.status(201).json({
      object: "prepaid_code",
      id: purchase.id,
      code: purchase.code,
      model: purchase.model,
      tokens: { total: purchase.tokens, remaining: purchase.tokens },
      api_base: "https://mapleai.shop/v1",
      status_url: prepaidStatusUrl,
      usage: {
        how_to: "Send the code as a Bearer token to the MapleAI prepaid endpoint. The code spends from its token budget; no per-request payment is needed.",
        authorization: `Bearer ${purchase.code}`,
        chat_endpoint: "POST https://mapleai.shop/v1/chat/completions",
        model: purchase.model,
        example: {
          url: "https://mapleai.shop/v1/chat/completions",
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${purchase.code}`,
          },
          body: {
            model: purchase.model,
            messages: [{ role: "user", content: "Hello" }],
            stream: false,
          },
        },
        models_url: "https://mapleai.shop/v1/models",
        docs_url: "https://mapleai.shop/AI-AGENTS.md",
      },
    });
  } catch (error) {
    console.error("[prepaid-codes] issuance failed:", error instanceof Error ? error.message : "unknown");
    res.status(503).json({ error: { message: "Prepaid code issuance is temporarily unavailable", type: "issuer_unavailable" } });
  }
}

if (prepaidCodesEnabled) app.post("/prepaid/codes", validatePrepaidCodePurchase, (req, res) => { void handlePrepaidCodePurchase(req, res); });
// Agent "tap": the paywall has already run; merge the auto defaults before validation.
if (prepaidCodesEnabled) app.post("/prepaid/codes/auto", (req, _res, next) => { req.body = normalizeAutoPurchase(req.body); next(); },
  validatePrepaidCodePurchase, (req, res) => { void handlePrepaidCodePurchase(req, res); });

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

/** Upstreams that alias a model (e.g. the internal combo router) must not leak the backing id. */
function rewriteStreamModel(line: string, model: string): string {
  if (!line.startsWith("data: {")) return line;
  return line.replace(/"model":"[^"]*"/, `"model":"${model}"`);
}

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
  if (!isModelEnabled(canonical)) {
    res.status(503).json({
      error: {
        message: `${canonical} is temporarily unavailable at the upstream provider. Retry later or pick another model from GET /v1/models.`,
        type: "upstream_error",
        code: "model_unavailable",
        details: { sellableModels: listModels().map((m) => m.id) },
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
      let carry = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = carry + decoder.decode(value, { stream: true });
        tail = (tail + text).slice(-65536);
        const lines = text.split("\n");
        carry = lines.pop() ?? "";
        for (const line of lines) res.write(rewriteStreamModel(line, upstreamModel) + "\n");
      }
      if (carry) res.write(rewriteStreamModel(carry, upstreamModel));
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

    let out = body.toString("utf8");
    try {
      const parsed = JSON.parse(out) as { model?: unknown };
      if (parsed && typeof parsed === "object" && typeof parsed.model === "string" && parsed.model !== upstreamModel) {
        parsed.model = upstreamModel;
        out = JSON.stringify(parsed);
      }
    } catch { /* non-JSON upstream body passes through unchanged */ }

    res.status(upstream.status);
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.send(out);
  } catch (error) {
    console.error("[proxy] upstream error:", error);
    res
      .status(502)
      .json({ error: { message: "upstream request failed", type: "upstream_error" } });
  }
}

app.post(["/v1/chat/completions", "/api/v1/chat/completions"], handleChatCompletions);

// Free gpt-oss-20b tier — no x402, quota-capped per agent, combo-routed.
if (freeGptOssEnabled) {
  app.post(["/v1/free/chat/completions", "/api/v1/free/chat/completions"], handleFreeGptOssChat);
  app.get("/v1/free/chat/completions/quota", (req: Request, res: Response) => {
    const ip = (req.get("cf-connecting-ip") ?? req.get("x-forwarded-for")?.split(",")[0]?.trim() ?? req.socket.remoteAddress) ?? "unknown";
    res.json({ object: "free_quota", model: freeGptOssModel, ...freeQuotaSnapshot(ip.slice(0, 80)) });
  });
}

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

// Transient upstream failures (rate limits, 5xx, transport errors, malformed
// success bodies) are retried within the same paid request. With Solana's
// upfront settlement the client has already paid by the time we call upstream,
// so a transient blip must not become a paid failure.
const IMAGE_RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const IMAGE_MAX_ATTEMPTS = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function handleImage(req: Request, res: Response, kind: ImageKind): Promise<void> {
  const image = res.locals.imageRequest as ImageRequest;
  for (let attempt = 1; attempt <= IMAGE_MAX_ATTEMPTS; attempt++) {
    const lastAttempt = attempt === IMAGE_MAX_ATTEMPTS;
    try {
      const upstream = await fetchImage(image, kind);
      const raw = await upstream.text();
      if (!upstream.ok) {
        if (IMAGE_RETRYABLE_STATUSES.has(upstream.status) && !lastAttempt) {
          console.warn("[images] upstream " + upstream.status + " for " + image.model + ", retry " + attempt);
          await sleep(attempt * 2000);
          continue;
        }
        console.error("[images] upstream " + upstream.status + ": " + raw.slice(0, 400));
        res.status(upstream.status).type("application/json").send(raw);
        return;
      }
      const data: unknown = JSON.parse(raw);
      if (!data || typeof data !== "object" || !Array.isArray((data as { data?: unknown }).data) ||
          (data as { data: unknown[] }).data.length !== image.n) {
        if (!lastAttempt) {
          console.warn("[images] unexpected upstream response for " + image.model + ", retry " + attempt);
          await sleep(attempt * 2000);
          continue;
        }
        console.error("[images] unexpected upstream response for " + image.model);
        res.status(502).json({ error: { message: "Unexpected upstream image response" } });
        return;
      }
      const results = (data as { data: Array<{ url?: unknown; b64_json?: unknown }> }).data;
      if (results.some((item) => !item || (typeof item.url !== "string" && typeof item.b64_json !== "string"))) {
        if (!lastAttempt) {
          console.warn("[images] missing image data for " + image.model + ", retry " + attempt);
          await sleep(attempt * 2000);
          continue;
        }
        res.status(502).json({ error: { message: "Missing image data in upstream response" } });
        return;
      }
      recordUsage({ ts: new Date().toISOString(), model: image.model, payer: extractPayer(req.get("payment-signature")),
        upstreamStatus: upstream.status, quotedUsd: await quoteImage(req.body) });
      res.status(200).json(data);
      return;
    } catch (error) {
      if (!lastAttempt) {
        console.warn("[images] transport error for " + image.model + ", retry " + attempt + ":",
          error instanceof Error ? error.name : "unknown");
        await sleep(attempt * 2000);
        continue;
      }
      console.error("[images] upstream error:", error);
      res.status(502).json({ error: { message: "Image request failed" } });
      return;
    }
  }
}

if (imagesEnabled) {
  app.post("/api/v1/images/generations", (req, res) => { void handleImage(req, res, "generation"); });
  app.post("/api/v1/images/image2image", (req, res) => { void handleImage(req, res, "edit"); });
}

async function handleSpeech(req: Request, res: Response): Promise<void> {
  const speech = res.locals.speechRequest as SpeechRequest;
  try {
    const result = await fetchSpeech(speech);
    recordUsage({
      ts: new Date().toISOString(),
      model: speech.model,
      payer: extractPayer(req.get("payment-signature")),
      upstreamStatus: 200,
      quotedUsd: await quoteSpeech(req.body ?? {}),
    });
    res.status(200)
      .setHeader("content-type", result.contentType)
      .setHeader("x-audio-upstream", result.upstream)
      .setHeader("x-fallback-used", result.fellBack ? "1" : "0")
      .send(result.audio);
  } catch (error) {
    const status = (error as { status?: number }).status;
    console.error("[audio] speech failed:", error instanceof Error ? error.message : "unknown");
    res.status(typeof status === "number" ? status : 502)
      .json({ error: { message: "TTS request failed", type: "upstream_error" } });
  }
}

async function handleTranscription(req: Request, res: Response): Promise<void> {
  const transcription = res.locals.transcriptionRequest as TranscriptionRequest;
  try {
    const result = await fetchTranscription(transcription);
    recordUsage({
      ts: new Date().toISOString(),
      model: transcription.model,
      payer: extractPayer(req.get("payment-signature")),
      upstreamStatus: 200,
      quotedUsd: await quoteTranscription(req.body ?? {}),
    });
    res.status(200)
      .setHeader("content-type", result.contentType)
      .setHeader("x-audio-upstream", result.upstream)
      .setHeader("x-fallback-used", result.fellBack ? "1" : "0")
      .send(result.raw);
  } catch (error) {
    const status = (error as { status?: number }).status;
    console.error("[audio] transcription failed:", error instanceof Error ? error.message : "unknown");
    res.status(typeof status === "number" ? status : 502)
      .json({ error: { message: "Transcription request failed", type: "upstream_error" } });
  }
}

if (speechEnabled) app.post("/v1/audio/speech", (req, res) => { void handleSpeech(req, res); });
if (transcriptionsEnabled) app.post("/v1/audio/transcriptions", (req, res) => { void handleTranscription(req, res); });

if (jevEnabled) app.post("/jev", async (req, res) => {  const started = Date.now();
  const logEntry = {
    domain: req.get("host") ?? "unknown",
    request: { state: (req.body as { state?: unknown })?.state, questions: (req.body as { questions?: unknown })?.questions },
    payer: extractPayer(req.get("payment-signature")),
  };
  try {
    const upstream = await fetchJev(req.body);
    const raw = await upstream.text();
    if (!upstream.ok) {
      console.error("[jev] upstream HTTP " + upstream.status);
      recordJevData({ ...logEntry, status: upstream.status, latencyMs: Date.now() - started,
        failure: { source: "upstream", reason: "upstream_http_" + upstream.status } });
      res.status(upstream.status).type("application/json").send(raw);
      return;
    }
    let data: unknown;
    try { data = JSON.parse(raw); } catch { data = undefined; }
    if (!data || typeof data !== "object" || !("answers" in data)) {
      recordJevData({ ...logEntry, status: 502, latencyMs: Date.now() - started,
        failure: { source: "upstream", reason: "unexpected_response" } });
      res.status(502).json({ error: { message: "Unexpected Jev response", type: "upstream_error" } });
      return;
    }
    recordJevData({ ...logEntry, status: 200, latencyMs: Date.now() - started, response: data });
    recordUsage({ ts: new Date().toISOString(), model: jevModel,
      payer: logEntry.payer, upstreamStatus: upstream.status, quotedUsd: await quoteJev(req.body) });
    res.status(200).json(data);
  } catch (error) {
    console.error("[jev] upstream request failed:", error instanceof Error ? error.name : "unknown");
    recordJevData({ ...logEntry, status: 502, latencyMs: Date.now() - started,
      failure: { source: "transport", reason: error instanceof Error ? error.name : "unknown" } });
    res.status(502).json({ error: { message: "Jev request failed", type: "upstream_error" } });
  }
});

if (agentsExecuteEnabled) app.post("/v1/agents/execute", async (req, res) => {
  await handleAgentsExecute(req, res);
});

if (xSearchEnabled) {
  app.post("/v1/x/digest", (req, res) => { void handleXDigest(req, res); });
  app.post("/v1/x/sentiment", (req, res) => { void handleXSentiment(req, res); });
  app.post("/v1/x/factcheck", (req, res) => { void handleXFactcheck(req, res); });
}

if (xSearchEnabled) app.post("/v1/x/search", async (req, res) => {
  try {
    const upstream = await fetchXSearch(req.body as Parameters<typeof fetchXSearch>[0]);
    const raw = await upstream.text();
    if (!upstream.ok) {
      console.error("[xsearch] combo router HTTP " + upstream.status);
      res.status(upstream.status).type("application/json").send(raw);
      return;
    }
    let data: unknown;
    try { data = JSON.parse(raw); } catch { data = undefined; }
    if (!data || typeof data !== "object") {
      res.status(502).json({ error: { message: "Unexpected search response", type: "upstream_error" } });
      return;
    }
    recordUsage({ ts: new Date().toISOString(), model: xSearchModel,
      payer: extractPayer(req.get("payment-signature")), upstreamStatus: upstream.status, quotedUsd: await quoteXSearch(req.body as Parameters<typeof quoteXSearch>[0]) });
    res.status(200).json(data);
  } catch (error) {
    console.error("[xsearch] request failed:", error instanceof Error ? error.name : "unknown");
    res.status(502).json({ error: { message: "X search request failed", type: "upstream_error" } });
  }
});

if (embeddingsEnabled) app.post("/v1/embeddings", async (req, res) => {
  try {
    const upstream = await fetchEmbeddings(req.body);
    const raw = await upstream.text();
    recordEmbeddingData(req.body, raw, upstream.status, req.get("host") ?? "unknown", embeddingModel);
    res.setHeader("x-mapleai-next", embeddingNextEndpoint);
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
    try {
      const data = JSON.parse(raw);
      if (data && typeof data === "object" && !Array.isArray(data)) data.hint_next = embeddingNextHint;
      res.status(200).json(data);
    } catch {
      res.status(200).type("application/json").send(raw);
    }
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
app.get(["/free-embeddings", "/free-embeddings/"], (req, res) =>
  sendDoc(req, res, "free-embeddings.html", "html"),
);

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
    })), ...imageData, ...(embeddingsEnabled ? [{ id: embeddingModel, object: "model", created: 1700000000, owned_by: "nvidia", type: "embedding", pricing: { input: 0, output: 0, unit: "free" }, endpoint: "/v1/embeddings" }] : []), ...(freeGptOssEnabled ? [{
      id: freeGptOssModel, object: "model", created: 1700000000, owned_by: "nvidia", type: "chat",
      endpoint: "/v1/free/chat/completions", pricing: { input: 0, output: 0, unit: "free" },
      free_tier: { per_10min_per_ip: config.freeGptOssPer10Min, per_day_per_ip: config.freeGptOssPerDay, max_output_tokens: config.freeGptOssMaxTokens },
    }] : []), ...(jevEnabled ? [{ id: jevModel, object: "model", created: 1700000000,
      owned_by: "jev", type: "structured_decision", protocols: { primary: "systemone", supported: ["systemone"] },
      endpoint: "/jev", pricing: { input: jevPricePerMillion, output: 0, unit: "USD per 1M tokens" } }] : []),
      ...(speechEnabled ? speechModels.map((id) => ({
        id, object: "model", created: 1700000000, owned_by: "google", type: "audio-tts",
        endpoint: "/v1/audio/speech", pricing: { per_request: speechPriceUsd, unit: "USD per request" },
      })) : []),
      ...(transcriptionsEnabled ? transcriptionModels.map((id) => ({
        id, object: "model", created: 1700000000, owned_by: "google", type: "audio-stt",
        endpoint: "/v1/audio/transcriptions", pricing: { per_request: transcriptionPriceUsd, unit: "USD per request" },
      })) : [])],
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
  const origin = originOf(req);
  // Card-grade display prices: crawlers get a stable per-resource range
  // without computing quotes; the exact amount still lives in the challenge.
  const minChargeDisplay = "$" + config.minChargeUsd.toFixed(4);
  const chatPriceDisplay = "from " + minChargeDisplay + " per request";
  const minImageUsd = imagesEnabled
    ? Math.min(...Object.values(imageRates).flatMap((sizes) => Object.values(sizes as Record<string, number>)))
    : 0;
  const imagePriceDisplay = "from $" + minImageUsd.toFixed(4) + " per image";
  const prepaidOffers = prepaidCodesEnabled ? prepaidModelOffers() : [];
  const prepaidPriceDisplay = prepaidOffers.length > 0
    ? "$" + Math.min(...prepaidOffers.map((o) => o.packPricesUsd[0].usd)).toFixed(3) +
      "-" + "$" + Math.max(...prepaidOffers.map((o) => o.packPricesUsd[1].usd)).toFixed(2) + " per pack + fee"
    : undefined;
  const resource = (method: string, path: string, extra: Record<string, unknown>) => ({
    method,
    path,
    description: CHAT_DESCRIPTION,
    price: chatPriceDisplay,
    tags: ["chat", "llm", "gpt"],
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
    serviceEndpoints: `${origin}/service-endpoints.json`,
    minimumChargeUsd: config.minChargeUsd,
    resources: [
      ...(nftEnabled ? Object.keys(nftNetworks).map((network) => ({ method: "GET", path: "/api/v1/" + network + "/nft/getNFTMetadata", description: nftDescription, price: nftPrice, tags: ["nft", "blockchain", "metadata"], pricedBy: "per request", exampleQuery: { contractAddress: nftExampleAddress } })) : []),
      resource("POST", "/v1/chat/completions", {}),
      resource("POST", "/api/v1/chat/completions", {}),

      {
        method: "POST",
        path: "/api/v1/responses",
        description: "OpenAI-compatible Responses API (alpha)",
        price: chatPriceDisplay,
        tags: ["chat", "llm", "gpt", "responses"],
        pricedBy: "input tokens + max_output_tokens, per-model $/1M-token rates",
      },
      {
        method: "POST",
        path: "/v1/responses",
        description: "OpenAI-compatible Responses API (alpha)",
        price: chatPriceDisplay,
        tags: ["chat", "llm", "gpt", "responses"],
        pricedBy: "input tokens + max_output_tokens, per-model $/1M-token rates",
      },
      ...(imagesEnabled ? [
        {
          method: "POST",
          path: "/api/v1/images/generations",
          description: "Image generation",
          price: imagePriceDisplay,
          tags: ["image", "generation"],
          pricedBy: "model, size and image count",
          exampleBody: imageExample,
        },
        {
          method: "POST",
          path: "/api/v1/images/image2image",
          description: "Image editing",
          price: imagePriceDisplay,
          tags: ["image", "editing"],
          pricedBy: "model, size and image count",
          exampleBody: imageEditExample,
        },
      ] : []),
      ...(embeddingsEnabled ? [{ method: "POST", path: "/v1/embeddings", description: "Free NVIDIA Nemotron embeddings (2048-dim)", price: "$0.00", tags: ["embeddings", "free"], pricedBy: "free", exampleBody: { input: "Hello", input_type: "query", encoding_format: "float" } }] : []),
      ...(speechEnabled ? [{ method: "POST", path: "/v1/audio/speech", description: "Text-to-speech synthesis (OpenAI-compatible, WAV output)", price: "$" + speechPriceUsd.toFixed(4) + " per request", tags: ["audio", "tts", "speech"], pricedBy: "per request", exampleBody: speechExample }] : []),
      ...(transcriptionsEnabled ? [{ method: "POST", path: "/v1/audio/transcriptions", description: "Audio transcription (speech-to-text, multipart or JSON base64)", price: "$" + transcriptionPriceUsd.toFixed(4) + " per request", tags: ["audio", "stt", "transcription"], pricedBy: "per request", exampleBody: { model: "whisper-1", file: "data:audio/mpeg;base64,..." } }] : []),
      ...(freeGptOssEnabled ? [{ method: "POST", path: "/v1/free/chat/completions", description: `Free nvidia/gpt-oss-20b chat (rate-limited ${config.freeGptOssPer10Min}/10min + ${config.freeGptOssPerDay}/day per agent)`, price: "$0.00", tags: ["chat", "free"], pricedBy: "free tier with per-agent quota", exampleBody: { model: "nvidia/gpt-oss-20b", messages: [{ role: "user", content: "Hello" }], stream: false } }] : []),
      ...(jevEnabled && jevPricePerMillion !== undefined ? [{ method: "POST", path: "/jev", description: "Jev structured decisions",
        price: chatPriceDisplay + " (" + "$" + jevPricePerMillion.toFixed(2) + "/1M input tokens)",
        tags: ["decision", "classification", "structured"], pricedBy: "input tokens plus payment overhead", exampleBody: jevExample }] : []),
      ...(xSearchEnabled ? [{ method: "POST", path: "/v1/x/search", description: "Live X/Twitter search via Grok x_search: summarized answer with direct post citations; include_web adds a web search pass",
        price: "$" + xSearchBasePriceUsd.toFixed(3) + " + $" + xSearchPerResultUsd.toFixed(4) + " per requested max_result (+$" + xSearchWebPriceUsd.toFixed(2) + " with include_web)",
        tags: ["search", "x", "twitter", "social"], pricedBy: "base + per requested max_result + optional web surcharge, plus payment overhead",
        exampleBody: { query: "trending AI agent frameworks", max_results: 10 } },
      { method: "POST", path: "/v1/x/digest", description: "Digest of specific X handles: key posts with links and engagement per handle, silent handles marked",
        price: "$" + digestBaseUsd.toFixed(3) + " + $" + digestPerHandleUsd.toFixed(3) + " per handle",
        tags: ["search", "x", "twitter", "digest", "monitoring"], pricedBy: "base + per handle, plus payment overhead",
        exampleBody: xDigestExample },
      { method: "POST", path: "/v1/x/sentiment", description: "X sentiment for a token, project or narrative: verdict, score, distribution, drivers, evidence posts",
        price: "$" + sentimentBaseUsd.toFixed(3) + " + $" + sentimentPerExampleUsd.toFixed(4) + " per example + $" + sentimentPerDayUsd.toFixed(3) + " per extra day of window",
        tags: ["search", "x", "twitter", "sentiment", "analytics"], pricedBy: "base + per example + per extra window day, plus payment overhead",
        exampleBody: xSentimentExample },
      { method: "POST", path: "/v1/x/factcheck", description: "Factcheck a claim against X posts and web sources: verdict, confidence, evidence for and against",
        price: "$" + factcheckBaseUsd.toFixed(3) + " + $" + factcheckPerSourceUsd.toFixed(3) + " per source slot",
        tags: ["search", "x", "twitter", "factcheck", "verification"], pricedBy: "base + per evidence source slot, plus payment overhead",
        exampleBody: xFactcheckExample }] : []),
      ...(agentsExecuteEnabled ? [{ method: "POST", path: "/v1/agents/execute", description: "Autonomous agent execution (multi-step reasoning + tools" + (codeExecEnabled ? " incl. sandboxed code_exec" : "") + ", SSE step events with stream=true). Engines: agents/oss-20b (cheap), agents/gpt-6-sol (premium)",
        price: chatPriceDisplay + " + engine base ($0.002/$0.004) + per-step ($0.0005/$0.004)" + (codeExecEnabled ? " + code_exec $0.002/call" : "") + " ceiling",
        tags: ["agents", "automation", "tools"], pricedBy: "settlement overhead + engine base fee + per-step price" + (codeExecEnabled ? ", code_exec $0.002/call (max 3 per task)" : "") + ", charged at the max_steps ceiling", exampleBody: agentsExample }] : []),
      ...(prepaidCodesEnabled ? [{
        method: "POST",
        path: "/prepaid/codes",
        description: "Buy a prepaid API code for one GPT model and a token budget in 100000-token steps (100000-1000000)",
        price: prepaidPriceDisplay,
        tags: ["prepaid", "credits", "key"],
        pricedBy: "input rate * tokens + network settlement fee",
        exampleBody: prepaidCodeExample,
        outputExample: prepaidCodeOutputExample,
      }, {
        method: "POST",
        path: "/prepaid/codes/auto",
        description: "One-shot agent tap: empty body buys the default 100000-token openai/gpt-6-luna key",
        price: prepaidPriceDisplay,
        tags: ["prepaid", "credits", "key", "tap"],
        pricedBy: "input rate * tokens + network settlement fee",
        exampleBody: {},
        outputExample: prepaidCodeOutputExample,
      }] : []),
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

/**
 * A2A agent card: enumerates skills for agent-to-agent discovery. The service
 * itself speaks OpenAI-compatible HTTP paid with x402 — no A2A JSON-RPC task
 * transport is claimed, skills point at HTTP additionalInterfaces instead.
 */
app.get("/.well-known/agent-card.json", (req: Request, res: Response) => {
  const models = catalog();
  const origin = originOf(req);
  const chain = chainInfo(config.network);
  const skill = (id: string, name: string, description: string, tags: string[], example: string) => ({
    id,
    name,
    description,
    tags,
    examples: [example],
    inputModes: ["application/json"],
    outputModes: ["application/json"],
  });
  const skills: Record<string, unknown>[] = [
    skill(
      "chat-completion",
      "GPT chat completions",
      `OpenAI-compatible chat completions with ${models.length} GPT models, priced per token. Exact quote in the 402 challenge.`,
      ["chat", "llm"],
      `POST ${origin}/v1/chat/completions {"model":"${models[0]?.id}","messages":[{"role":"user","content":"Hello"}]}`,
    ),
    skill(
      "responses-api",
      "OpenAI Responses API",
      "OpenAI Responses API (alpha) translated to chat completions upstream.",
      ["chat", "responses"],
      `POST ${origin}/api/v1/responses {"model":"${models[0]?.id}","input":"Hello"}`,
    ),
  ];
  if (embeddingsEnabled) {
    skills.push(skill(
      "embed-text",
      "Free embeddings",
      `2048-dim embeddings via ${embeddingModel}; free, no payment, up to 128 strings per call.`,
      ["embeddings", "free", "search"],
      `POST ${origin}/v1/embeddings {"input":"Hello","input_type":"query"}`,
    ));
  }
  if (speechEnabled) {
    skills.push(skill(
      "text-to-speech",
      "Text-to-speech synthesis",
      `OpenAI-compatible TTS (${speechModels.join(", ")}); WAV audio, $${speechPriceUsd.toFixed(4)} per request.`,
      ["audio", "tts", "speech"],
      `POST ${origin}/v1/audio/speech {"model":"${speechModels[0]}","input":"Hello","voice":"alloy"}`,
    ));
  }
  if (transcriptionsEnabled) {
    skills.push(skill(
      "speech-to-text",
      "Audio transcription",
      `OpenAI-compatible transcription (whisper-1 id, Gemini backend); multipart file or JSON base64, $${transcriptionPriceUsd.toFixed(4)} per request.`,
      ["audio", "stt", "transcription"],
      `POST ${origin}/v1/audio/transcriptions -F file=@audio.mp3 -F model=whisper-1`,
    ));
  }
  if (freeGptOssEnabled) {
    skills.push(skill(
      "chat-free-gptoss",
      "Free gpt-oss-20b chat",
      `Free ${freeGptOssModel} chat completions; rate-limited ${config.freeGptOssPer10Min}/10min + ${config.freeGptOssPerDay}/day per agent IP, max ${config.freeGptOssMaxTokens} output tokens. No payment required.`,
      ["chat", "free", "gpt-oss"],
      `POST ${origin}/v1/free/chat/completions {"messages":[{"role":"user","content":"Hello"}],"stream":false}`,
    ));
  }
  if (imagesEnabled) {
    skills.push(
      skill(
        "image-generation",
        "Image generation",
        `Image generation with ${Object.keys(imageRates).length} models, priced per image and size.`,
        ["image"],
        `POST ${origin}/api/v1/images/generations {"model":"gpt-image-2","size":"1024x1024","prompt":"A maple leaf"}`,
      ),
      skill(
        "image-editing",
        "Image editing",
        "Edit a PNG, JPEG or WebP supplied as a base64 data URI (maximum 10 MB).",
        ["image", "editing"],
        `POST ${origin}/api/v1/images/image2image {"model":"gpt-image-2","size":"1024x1024","prompt":"Make the leaf green","image":"data:image/png;base64,..."}`,
      ),
    );
  }
  if (jevEnabled) {
    skills.push(skill(
      "jev-decision",
      "Structured decisions",
      `Structured decisions via ${jevModel}: named questions (noul/choice/score) with instructions in, JSON answers out. $${jevPricePerMillion?.toFixed(2)}/1M input tokens.`,
      ["decision", "structured"],
      `POST ${origin}/jev {"model":"${jevModel}","state":"...","questions":{"billing":{"type":"noul","instructions":"Is this about billing?"}}}`,
    ));
  }
  if (prepaidCodesEnabled) {
    skills.push(
      skill(
        "buy-prepaid-key",
        "Buy a prepaid API key",
        "Issues a prepaid OpenAI-compatible bearer key for one GPT model (100000-1000000 token budget).",
        ["prepaid", "budget"],
        `POST ${origin}/prepaid/codes/auto {}`,
      ),
      skill(
        "prepaid-key-status",
        "Check prepaid key status",
        `Free validity and token-budget check for an oms_buy_ key: GET ${prepaidStatusUrl} with the key as Bearer.`,
        ["prepaid", "free"],
        `GET ${prepaidStatusUrl} -H "Authorization: Bearer oms_buy_..."`,
      ),
    );
  }
  res.json({
    protocolVersion: "0.2.1",
    name: config.serviceName,
    description:
      `Pay-per-request AI API on ${chain.networkName}: GPT chat, image generation/editing, ` +
      "Jev structured decisions, free embeddings and prepaid token packs. Skilled via the " +
      "OpenAI-compatible HTTP interface in additionalInterfaces; every paid endpoint answers " +
      "HTTP 402 with a x402 payment challenge first.",
    url: origin,
    version: "1.0.0",
    capabilities: {
      streaming: true,
      extensions: [
        {
          uri: "https://github.com/coinbase/x402",
          description: "x402 v2 pay-per-request: the first attempt returns HTTP 402 with PAYMENT-REQUIRED; retry with a signed PAYMENT-SIGNATURE header.",
          required: true,
        },
      ],
    },
    additionalInterfaces: [
      { url: `${origin}/v1`, transport: "HTTP", description: "OpenAI-compatible API (chat completions, embeddings, models)" },
      { url: `${origin}/api/v1`, transport: "HTTP", description: "OpenAI-compatible API plus images and responses aliases" },
      ...(prepaidCodesEnabled ? [{ url: prepaidApiBaseUrl, transport: "HTTP", description: "OpenAI-compatible API scoped to prepaid oms_buy_ bearer keys" }] : []),
    ],
    securitySchemes: {
      x402: {
        type: "apiKey",
        in: "header",
        name: "PAYMENT-SIGNATURE",
        description: "x402 payment payload obtained from the 402 challenge (PAYMENT-REQUIRED header)",
      },
    },
    security: [{ x402: [] }],
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills,
    provider: { organization: config.serviceName, url: origin },
  });
});

/**
 * One-shot machine-readable index of everything this instance serves: routes,
 * access mode (x402 / free / prepaid bearer) and live per-unit pricing, so a
 * discovery agent can catalog the whole service from a single document.
 */
app.get("/service-endpoints.json", (req: Request, res: Response) => {
  const models = catalog();
  const origin = originOf(req);
  const facilitator = config.facilitatorMode === "cdp" ? CDP_FACILITATOR_URL : config.facilitatorUrl;
  const chatPricing = models.map((m) => ({
    model: m.id,
    inputUsdPerMillion: m.pricing.input,
    outputUsdPerMillion: m.pricing.output,
  }));

  const endpoints: Record<string, unknown>[] = [
    {
      method: "POST",
      path: "/v1/chat/completions",
      access: "x402",
      description: "OpenAI-compatible chat completions",
      pricing: { kind: "dynamic", formula: "input_tokens * input_rate + max_tokens * output_rate + overhead", models: chatPricing, overheadUsd: config.minChargeUsd },
      aliases: ["/api/v1/chat/completions"],
      example: { model: models[0]?.id, messages: [{ role: "user", content: "Hello" }] },
    },
    {
      method: "POST",
      path: "/api/v1/responses",
      access: "x402",
      description: "OpenAI-compatible Responses API (alpha)",
      pricing: { kind: "dynamic", formula: "input_tokens * input_rate + max_output_tokens * output_rate + overhead", models: chatPricing, overheadUsd: config.minChargeUsd },
      aliases: ["/v1/responses"],
      example: { model: models[0]?.id, input: "Hello" },
    },
    { method: "GET", path: "/v1/models", access: "free", description: "Model catalog with pricing and context windows" },
    { method: "GET", path: "/health", access: "free", description: "Service liveness and configuration summary" },
  ];

  if (embeddingsEnabled) {
    endpoints.push({
      method: "POST",
      path: "/v1/embeddings",
      access: "free",
      description: "Free NVIDIA embeddings (2048-dim vectors)",
      pricing: { kind: "free", usd: 0 },
      example: { input: "Hello", input_type: "query", encoding_format: "float" },
    });
  }

  if (freeGptOssEnabled) {
    endpoints.push(
      {
        method: "POST",
        path: "/v1/free/chat/completions",
        access: "free",
        description: `Free ${freeGptOssModel} chat completions, rate-limited ${config.freeGptOssPer10Min}/10min and ${config.freeGptOssPerDay}/day per agent IP, max_tokens capped at ${config.freeGptOssMaxTokens}`,
        pricing: { kind: "free", usd: 0, quota: { per10Min: config.freeGptOssPer10Min, perDay: config.freeGptOssPerDay } },
        example: { messages: [{ role: "user", content: "Hello" }], stream: false },
      },
      {
        method: "GET",
        path: "/v1/free/chat/completions/quota",
        access: "free",
        description: "Current free-tier window usage for the caller IP",
        pricing: { kind: "free", usd: 0 },
      },
    );
  }

  if (speechEnabled) {
    endpoints.push({
      method: "POST",
      path: "/v1/audio/speech",
      access: "x402",
      description: "Text-to-speech synthesis (OpenAI-compatible), WAV output",
      pricing: { kind: "per_request", usd: speechPriceUsd, models: speechModels, overheadUsd: config.minChargeUsd },
      example: speechExample,
    });
  }

  if (transcriptionsEnabled) {
    endpoints.push({
      method: "POST",
      path: "/v1/audio/transcriptions",
      access: "x402",
      description: "Audio transcription (speech-to-text) via multipart upload or JSON base64 audio",
      pricing: { kind: "per_request", usd: transcriptionPriceUsd, models: transcriptionModels, overheadUsd: config.minChargeUsd },
      example: { model: "whisper-1", file: "data:audio/mpeg;base64,..." },
    });
  }

  if (imagesEnabled) {
    const imagePricing = Object.entries(imageRates).flatMap(([model, sizes]) =>
      Object.entries(sizes).map(([size, usd]) => ({ model, size, usdPerImage: usd })),
    );
    endpoints.push(
      {
        method: "POST",
        path: "/api/v1/images/generations",
        access: "x402",
        description: "Image generation, n 1-4, price per image by model and size",
        pricing: { kind: "per_image", models: imagePricing, overheadUsd: config.minChargeUsd },
        example: imageExample,
      },
      {
        method: "POST",
        path: "/api/v1/images/image2image",
        access: "x402",
        description: "Image editing from a PNG, JPEG or WebP base64 data URI (max 10 MB)",
        pricing: { kind: "per_image", models: imagePricing, overheadUsd: config.minChargeUsd },
        example: imageEditExample,
      },
    );
  }

  if (jevEnabled) {
    endpoints.push({
      method: "POST",
      path: "/jev",
      access: "x402",
      description: "Jev structured decisions (SystemOne: state + named questions)",
      pricing: { kind: "per_million_input_tokens", usd: jevPricePerMillion, overheadUsd: config.minChargeUsd },
      example: jevExample,
    });
  }

  if (xSearchEnabled) {
    endpoints.push({
      method: "POST",
      path: "/v1/x/search",
      access: "x402",
      description: "Live X/Twitter search via Grok x_search: summarized answer with direct post citations; include_web adds a web search pass",
      pricing: { kind: "formula", formula: "base + per_result * max_results (+web surcharge with include_web)",
        baseUsd: xSearchBasePriceUsd, perResultUsd: xSearchPerResultUsd, webSurchargeUsd: xSearchWebPriceUsd, overheadUsd: config.minChargeUsd },
      example: { query: "trending AI agent frameworks", max_results: 10 },
    });
    endpoints.push({
      method: "POST",
      path: "/v1/x/digest",
      access: "x402",
      description: "Digest of specific X handles over a look-back window: key posts with links and engagement, silent handles marked",
      pricing: { kind: "formula", formula: "base + per_handle * handles (+media surcharge with include_media)",
        baseUsd: digestBaseUsd, perHandleUsd: digestPerHandleUsd, mediaSurchargeUsd: digestMediaUsd, overheadUsd: config.minChargeUsd },
      example: xDigestExample,
    });
    endpoints.push({
      method: "POST",
      path: "/v1/x/sentiment",
      access: "x402",
      description: "X sentiment for a token, project or narrative: verdict, -1..1 score, distribution, drivers, evidence posts",
      pricing: { kind: "formula", formula: "base + per_example * max_examples + per_day * extra_window_days",
        baseUsd: sentimentBaseUsd, perExampleUsd: sentimentPerExampleUsd, perDayUsd: sentimentPerDayUsd, overheadUsd: config.minChargeUsd },
      example: xSentimentExample,
    });
    endpoints.push({
      method: "POST",
      path: "/v1/x/factcheck",
      access: "x402",
      description: "Factcheck a claim against X posts and web sources: verdict (confirmed/refuted/mixed/unverified), confidence, evidence",
      pricing: { kind: "formula", formula: "base + per_source * max_sources",
        baseUsd: factcheckBaseUsd, perSourceUsd: factcheckPerSourceUsd, overheadUsd: config.minChargeUsd },
      example: xFactcheckExample,
    });
  }

  if (agentsExecuteEnabled) {
    endpoints.push({
      method: "POST",
      path: "/v1/agents/execute",
      access: "x402",
      description: "Autonomous agent execution (multi-step reasoning with calculator, fetch_url, web_search, data_analysis" +
        (codeExecEnabled ? ", code_exec" : "") + " tools; stream=true streams SSE step events)",
      pricing: {
        kind: "ceiling",
        formula: "engine base + max_steps * step" + (codeExecEnabled ? " + min(3, max_steps) * code_exec_fee" : "") + " + overhead",
        engines: agentsEnginePricing(),
        ...(codeExecEnabled ? { codeExecUsdPerCall: codeExecPerCallUsd, codeExecMaxPerTask } : {}),
        overheadUsd: config.minChargeUsd,
      },
      example: agentsExample,
    });
  }

  if (nftEnabled) {
    endpoints.push({
      method: "GET",
      path: "/api/v1/{chainNetwork}/nft/getNFTMetadata",
      access: "x402",
      description: "On-chain NFT contract metadata",
      pricing: { kind: "per_request", usd: 0.002 },
      networks: Object.keys(nftNetworks),
      exampleQuery: { contractAddress: nftExampleAddress },
    });
  }

  if (prepaidCodesEnabled) {
    endpoints.push({
      method: "POST",
      path: "/prepaid/codes",
      access: "x402",
      description: "Buy a prepaid API key for one GPT model; budget 100000-1000000 tokens in 100000 steps",
      pricing: { kind: "pack", models: prepaidModelOffers(), overheadUsd: config.minChargeUsd },
      example: prepaidCodeExample,
      outputExample: prepaidCodeOutputExample,
    });
    endpoints.push({
      method: "POST",
      path: "/prepaid/codes/auto",
      access: "x402",
      description: "Agent tap: empty body buys the default 100000-token openai/gpt-6-luna key",
      pricing: { kind: "pack", models: prepaidModelOffers(), overheadUsd: config.minChargeUsd },
      example: {},
      outputExample: prepaidCodeOutputExample,
    });
    endpoints.push({
      method: "GET",
      url: prepaidStatusUrl,
      access: "prepaid_bearer",
      description: "Check a prepaid key: valid, reason, tokens total/used/reserved/remaining",
      pricing: { kind: "free", usd: 0 },
      auth: "Authorization: Bearer oms_buy_...",
    });
    endpoints.push({
      method: "POST",
      url: `${prepaidApiBaseUrl}/chat/completions`,
      access: "prepaid_bearer",
      description: "OpenAI-compatible chat with a prepaid key; usage depletes the token budget",
      pricing: { kind: "prepaid_budget" },
      auth: "Authorization: Bearer oms_buy_...",
    });
  }

  res.json({
    object: "service_endpoints",
    version: 1,
    service: config.serviceName,
    origin,
    updated: new Date().toISOString(),
    network: config.network,
    networkName: chain.networkName,
    payment: {
      protocol: "x402",
      asset: chain.asset,
      assetAddress: chain.assetAddress,
      payTo: config.payTo,
      facilitator,
      minimumChargeUsd: config.minChargeUsd,
    },
    endpoints,
    discovery: {
      openapi: `${origin}/openapi.json`,
      x402Manifest: `${origin}/.well-known/x402`,
      agentCard: `${origin}/.well-known/agent-card.json`,
      llms: `${origin}/llms.txt`,
      agents: `${origin}/AI-AGENTS.md`,
      modelCatalog: `${origin}/v1/models`,
      status: prepaidCodesEnabled ? prepaidStatusUrl : undefined,
    },
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

  // Replayable requests: each listed cURL is verified to return 200/201 after
  // the 402 challenge gets a valid PAYMENT-SIGNATURE.
  const workedCurl = (method: string, path: string, body?: unknown): string =>
    "curl -X " + method + " " + origin + path +
    (body === undefined
      ? ""
      : " \\\n  -H 'content-type: application/json' \\\n  -d '" + JSON.stringify(body) + "'");
  const workedExample = (method: string, path: string, body: unknown, paid: boolean) => ({
    curl: workedCurl(method, path, body),
    ...(paid
      ? { payment: "x402", firstAttempt: "402 with PAYMENT-REQUIRED; sign and retry with PAYMENT-SIGNATURE" }
      : { payment: "none" }),
  });

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

  const successfulResponse = (schema: Record<string, unknown>, example?: unknown) => ({
    description: "Successful completion. Set stream: true for server-sent events.",
    content: {
      "application/json": { schema, ...(example === undefined ? {} : { example }) },
      "text/event-stream": {
        schema: { type: "string", description: "Server-sent events ending with data: [DONE]" },
      },
    },
  });

  const paidResponses = {
    "200": successfulResponse(chatCompletionSchema, {
      id: "chatcmpl_worked",
      object: "chat.completion",
      created: 1700000000,
      model: models[0]?.id,
      choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 },
    }),
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
    "200": successfulResponse(responseSchema, {
      id: "resp_worked",
      object: "response",
      created_at: 1700000000,
      status: "completed",
      model: models[0]?.id,
      output: [{ id: "msg_worked", type: "message", status: "completed", role: "assistant",
        content: [{ type: "output_text", text: "OK", annotations: [] }] }],
      output_text: "OK",
      usage: { input_tokens: 11, output_tokens: 5, total_tokens: 16 },
    }),
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
      ...(config.ownershipProofs.length > 0 ? { ownershipProofs: config.ownershipProofs } : {}),
    },
    // x402scan ownership verification: signatures over the origin, signed by
    // the payTo treasury wallet. The catalog marks accepts verified when a
    // proof here matches payTo + origin.
    ...(config.ownershipProofs.length > 0 ? { "x-agentcash-provenance": { ownershipProofs: config.ownershipProofs } } : {}),
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
      ...(nftEnabled ? Object.fromEntries(Object.keys(nftNetworks)
      .map((network) => ["/api/v1/" + network + "/nft/getNFTMetadata", { get: {
        summary: "Get NFT contract metadata", description: nftDescription + ". Returns on-chain contract metadata; optional fields are null when unsupported. Does not enumerate wallet NFTs or fetch off-chain token metadata.",
        operationId: "getNFTMetadata_" + network.replace(/-/g, "_"), security: [{ x402: [] }],
        "x-worked-example": workedExample("GET", "/api/v1/" + network + "/nft/getNFTMetadata?contractAddress=" + nftExampleAddress, undefined, true),
        "x-payment-info": { price: { mode: "fixed", amount: 0.002, currency: "USD" }, protocols: [{ x402: {} }] },
        parameters: [{ name: "contractAddress", in: "query", required: true, schema: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" }, example: nftExampleAddress }],
        responses: { "200": { description: "On-chain NFT contract metadata" }, "400": { description: "Invalid contract address" }, "402": paidResponses["402"], "404": { description: "Contract not found" }, "502": { description: "Infura unavailable" } },
      } }])) : {}),
      ...(imagesEnabled ? {
        "/api/v1/images/generations": { post: { summary: "Generate images", operationId: "generateImages", security: [{ x402: [] }],
          "x-worked-example": workedExample("POST", "/api/v1/images/generations", imageExample, true),
          "x-payment-info": { price: { mode: "dynamic", currency: "USD" }, protocols: [{ x402: {} }] },
          "x-pricing": { unit: "USD per image", models: imageRates }, requestBody: imageBody(false), responses: imageResponse } },
        "/api/v1/images/image2image": { post: { summary: "Edit an image", operationId: "editImage", security: [{ x402: [] }],
          "x-worked-example": workedExample("POST", "/api/v1/images/image2image", imageEditExample, true),
          "x-payment-info": { price: { mode: "dynamic", currency: "USD" }, protocols: [{ x402: {} }] },
          "x-pricing": { unit: "USD per image", models: imageRates }, requestBody: imageBody(true), responses: imageResponse } },
      } : {}),
      ...(speechEnabled ? {
        "/v1/audio/speech": { post: { summary: "Text-to-speech synthesis", operationId: "createSpeech", security: [{ x402: [] }],
          "x-worked-example": workedExample("POST", "/v1/audio/speech", speechExample, true),
          "x-payment-info": { price: { mode: "fixed", amount: speechPriceUsd, currency: "USD" }, protocols: [{ x402: {} }] },
          requestBody: { required: true, content: { "application/json": { example: speechExample, schema: {
            type: "object", required: ["model", "input"],
            properties: { model: { type: "string", enum: speechModels }, input: { type: "string", maxLength: 5000 },
              voice: { type: "string", default: "alloy" }, response_format: { type: "string", enum: ["wav"], default: "wav" },
              speed: { type: "number", minimum: 0.25, maximum: 4 } },
          } } } },
          responses: {
            "200": { description: "Synthesized audio", content: { "audio/wav": { schema: { type: "string", format: "binary" } } } },
            "400": { description: "Invalid speech request" },
            "402": paidResponses["402"],
            "502": { description: "TTS upstream failed" },
          } } },
      } : {}),
      ...(transcriptionsEnabled ? {
        "/v1/audio/transcriptions": { post: { summary: "Transcribe audio (speech-to-text)", operationId: "createTranscription", security: [{ x402: [] }],
          "x-payment-info": { price: { mode: "fixed", amount: transcriptionPriceUsd, currency: "USD" }, protocols: [{ x402: {} }] },
          requestBody: { required: true, content: {
            "multipart/form-data": { schema: { type: "object", required: ["file"], properties: {
              file: { type: "string", format: "binary", description: "Audio file (mp3, wav, m4a, ogg, flac, webm), max 25 MB" },
              model: { type: "string", enum: transcriptionModels, default: "whisper-1" },
              response_format: { type: "string", enum: ["json", "text", "verbose_json", "srt", "vtt"], default: "json" } } } },
            "application/json": { schema: { type: "object", required: ["file"], properties: {
              model: { type: "string", enum: transcriptionModels, default: "whisper-1" },
              file: { type: "string", description: "Audio as base64 or data URI, max 25 MB" },
              response_format: { type: "string", enum: ["json", "text", "verbose_json", "srt", "vtt"], default: "json" } } } },
          } },
          responses: {
            "200": { description: "Transcript", content: { "application/json": { example: { text: "Hello from MapleAI" } } } },
            "400": { description: "Invalid transcription request" },
            "402": paidResponses["402"],
            "502": { description: "Transcription upstream failed" },
          } } },
      } : {}),
      ...(prepaidCodesEnabled ? {
        "/prepaid/codes": {
          post: {
            summary: "Buy a prepaid GPT API code",
            operationId: "buyPrepaidCode",
            security: [{ x402: [] }],
            description:
              "Purchases a prepaid bearer API key for https://mapleai.shop/v1. " +
              "The key is limited to the selected model and a total token budget " +
              "in 100000-token steps from 100000 to 1000000. " +
              "Pricing uses the model input rate plus the network settlement fee. " +
              "Check key usage and status any time: GET https://mapleai.shop/v1/prepaid/status " +
              "with the prepaid key as the Bearer token.",
            "x-payment-info": { price: { mode: "dynamic", currency: "USD" }, protocols: [{ x402: {} }] },
            "x-worked-example": workedExample("POST", "/prepaid/codes", prepaidCodeExample, true),
            "x-pricing": {
              unit: "prepaid token pack",
              models: Object.fromEntries(sellablePrepaidModels.map((model) => [model, pricingForModel(model)])),
            },
            requestBody: {
              required: true,
              content: { "application/json": { schema: prepaidCodeInputSchema, example: prepaidCodeExample } },
            },
            responses: {
              "201": { description: "Prepaid bearer API key", content: { "application/json": { example: prepaidCodeOutputExample } } },
              "400": { description: "Invalid model or token amount" },
              "402": paidResponses["402"],
              "503": { description: "Prepaid key issuer unavailable" },
            },
          },
        },
        "/prepaid/codes/auto": {
          post: {
            summary: "One-shot prepaid tap (empty body)",
            operationId: "buyPrepaidCodeAuto",
            security: [{ x402: [] }],
            description:
              "POST with an empty or partial body: defaults buy a 100000-token " +
              "openai/gpt-6-luna prepaid key without any parameters. " +
              "Optional model and tokens override follow the same rules as /prepaid/codes.",
            "x-payment-info": { price: { mode: "dynamic", currency: "USD" }, protocols: [{ x402: {} }] },
            "x-worked-example": workedExample("POST", "/prepaid/codes/auto", {}, true),
            requestBody: {
              required: false,
              content: { "application/json": { schema: { type: "object", properties: { model: { type: "string", enum: sellablePrepaidModels }, tokens: { type: "integer", minimum: 100_000, maximum: 1_000_000 } } }, example: {} } },
            },
            responses: {
              "201": { description: "Prepaid bearer API key", content: { "application/json": { example: prepaidCodeOutputExample } } },
              "400": { description: "Invalid model or token amount" },
              "402": paidResponses["402"],
              "503": { description: "Prepaid key issuer unavailable" },
            },
          },
        },
      } : {}),
      ...(embeddingsEnabled ? {
        "/v1/embeddings": {
          post: {
            summary: "Create free embeddings",
            operationId: "createEmbeddings",
            security: [],
            "x-worked-example": workedExample("POST", "/v1/embeddings", { input: "Hello", input_type: "query", encoding_format: "float" }, false),
            description:
              `Free NVIDIA Nemotron embeddings. Every request is routed to ${embeddingModel}; ` +
              "any supplied model value is ignored. Discovery and health probes that send a body " +
              "containing only a model field (no input) receive HTTP 200 with an empty data list " +
              "and a hint describing the expected input, so automated crawlers pass on the first try. ",
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: embeddingRequestSchema,
                  example: { input: "Hello", input_type: "query", encoding_format: "float" },
                  examples: {
                    single: {
                      summary: "Single text",
                      value: { input: "Hello", input_type: "query", encoding_format: "float" },
                    },
                    batch: {
                      summary: "Batch of texts (max 128)",
                      value: { input: ["first document", "second document"], input_type: "passage" },
                    },
                    probe: {
                      summary: "Discovery probe (model-only body returns 200 with a hint)",
                      value: { model: "nvidia/nemotron-3-embed-1b" },
                    },
                  },
                },
              },
            },
            responses: {
              "200": {
                description: "Embedding vectors per input, or an empty data list with a hint for model-only probes.",
                content: {
                  "application/json": {
                    examples: {
                      embeddings: {
                        summary: "Embeddings response",
                        value: {
                          object: "list",
                          data: [{ object: "embedding", index: 0, embedding: [0.0123, -0.0456] }],
                          model: "nvidia/nemotron-3-embed-1b",
                        },
                      },
                      probe: {
                        summary: "Probe response (model-only body)",
                        value: {
                          object: "list",
                          data: [],
                          model: "nvidia/nemotron-3-embed-1b",
                          hint: 'Send {"input": "your text"} or {"input": ["up to 128 strings"]}',
                        },
                      },
                    },
                  },
                },
              },
              "400": {
                description: "Invalid request body. The error includes the expected request schema.",
                content: { "application/json": { schema: embeddingValidationErrorSchema } },
              },
              "502": { description: "NVIDIA upstream failed" },
            },
          },
        },
      } : {}),
      ...(freeGptOssEnabled ? {
        "/v1/free/chat/completions": {
          post: {
            summary: "Free gpt-oss-20b chat completions",
            operationId: "freeGptOssChat",
            security: [],
            "x-worked-example": workedExample("POST", "/v1/free/chat/completions", { messages: [{ role: "user", content: "Hello" }], stream: false }, false),
            description:
              `Free ${freeGptOssModel} chat via the same OpenAI Chat Completions shape as the paid endpoint. ` +
              `No payment and no key. Rate-limited per agent IP: ${config.freeGptOssPer10Min} requests per 10 minutes ` +
              `and ${config.freeGptOssPerDay} per day; max_tokens is capped at ${config.freeGptOssMaxTokens}. ` +
              "Exceeding the window returns HTTP 429 with a free_tier_exhausted code and a retry-after. " +
              "Window usage: GET /v1/free/chat/completions/quota.",
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["messages"],
                    properties: {
                      model: { type: "string", description: `Optional; only ${freeGptOssModel} is accepted` },
                      messages: { type: "array", minItems: 1, items: { type: "object", required: ["role", "content"], properties: { role: { type: "string" }, content: { type: "string" } } } },
                      max_tokens: { type: "integer", maximum: config.freeGptOssMaxTokens },
                      stream: { type: "boolean" },
                    },
                  },
                  example: { messages: [{ role: "user", content: "Hello" }], stream: false },
                },
              },
            },
            responses: {
              "200": {
                description: "Chat completion object with model echoed as nvidia/gpt-oss-20b.",
                content: { "application/json": { example: {
                  id: "chatcmpl_free", object: "chat.completion", model: freeGptOssModel,
                  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Hello!" } }],
                  usage: { prompt_tokens: 32, completion_tokens: 6, total_tokens: 38 },
                } } },
              },
              "400": { description: "Invalid request body (wrong model or missing messages)" },
              "429": { description: "Free tier window exhausted for this agent IP; retry-after included." },
              "502": { description: "Upstream temporarily unavailable" },
            },
          },
        },
        "/v1/free/chat/completions/quota": {
          get: {
            summary: "Free tier window usage for the caller IP",
            operationId: "freeGptOssQuota",
            security: [],
            responses: {
              "200": {
                description: "Current usage and limits for both windows.",
                content: { "application/json": { example: {
                  object: "free_quota", model: freeGptOssModel,
                  per10Min: { limit: config.freeGptOssPer10Min, used: 0 },
                  perDay: { limit: config.freeGptOssPerDay, used: 0 },
                } } },
              },
            },
          },
        },
      } : {}),
      ...(jevEnabled ? { "/jev": { post: { summary: "Run Jev structured decision", operationId: "runJev",
        description: "SystemOne protocol for jev-latest. Returns structured answers, not chat text.",
        security: [{ x402: [] }],
        "x-worked-example": workedExample("POST", "/jev", jevExample, true),
        "x-payment-info": { price: { mode: "dynamic", currency: "USD" }, protocols: [{ x402: {} }] },
        "x-pricing": { unit: "USD per 1M tokens", input: jevPricePerMillion, output: 0 },
        requestBody: { required: true, content: { "application/json": { example: jevExample, schema: jevSchema } } },
        responses: { "200": { description: "Structured answers", content: { "application/json": {
          example: { model: "jev-1.13.0", answers: { billing: { type: "noul", noul: 0.98 } },
            usage: { input_tokens: 282, output_tokens: 20 } },
        } } }, "400": { description: "Invalid request" },
          "402": paidResponses["402"], "502": { description: "Upstream unavailable" } },
      } } } : {}),
      ...(xSearchEnabled ? { "/v1/x/search": { post: { summary: "Live X/Twitter search", operationId: "searchX",
        description: "Server-side Grok x_search over X posts. Returns a Responses API object: output_text summarizes the findings with direct post links, citations collected as url_citation entries. include_web adds a web_search pass alongside X.",
        security: [{ x402: [] }],
        "x-worked-example": workedExample("POST", "/v1/x/search", { query: "trending AI agent frameworks", max_results: 10 }, true),
        "x-payment-info": { price: { mode: "dynamic", currency: "USD" }, protocols: [{ x402: {} }] },
        "x-pricing": { unit: "USD per query", formula: "base + per_result * max_results (+web surcharge with include_web)",
          base: xSearchBasePriceUsd, perResult: xSearchPerResultUsd, webSurcharge: xSearchWebPriceUsd,
          defaultTotal: xSearchBasePriceUsd + xSearchPerResultUsd * 10, note: "max_results defaults to 10, max 25" },
        requestBody: { required: true, content: { "application/json": { example: { query: "trending AI agent frameworks", max_results: 10 },
          schema: { type: "object", required: ["query"], properties: {
            query: { type: "string", maxLength: 2000, description: "What to look for on X/Twitter" },
            max_results: { type: "integer", minimum: 1, maximum: 25, default: 10, description: "Maximum posts cited; drives the price" },
            include_web: { type: "boolean", default: false, description: "Also run web_search alongside X (adds the web surcharge)" },
            instructions: { type: "string", description: "Optional extra instructions for the search agent (e.g. quote posts verbatim, include author/date/likes)" },
          } } } } },
        responses: { "200": { description: "Responses API object with the summary and citations", content: { "application/json": {
          example: { object: "response", output_text: "AI agents are trending around x402 payments. https://x.com/user/status/123[[1]]",
            citations: ["https://x.com/user/status/123"], usage: { input_tokens: 1200, output_tokens: 300 } } } } },
          "400": { description: "Invalid request" },
          "402": paidResponses["402"], "502": { description: "Search upstream unavailable" } },
      } } } : {}),
      ...(xSearchEnabled ? { "/v1/x/digest": { post: { summary: "Digest of specific X handles", operationId: "xDigest",
        description: "Server-side Grok x_search restricted to the given handles (allowed_x_handles). Per handle: up to max_posts_per_handle key posts with links, likes and reposts, plus recurring themes; silent handles are marked. include_media enables image understanding inside posts (surcharge).",
        security: [{ x402: [] }],
        "x-worked-example": workedExample("POST", "/v1/x/digest", xDigestExample, true),
        "x-payment-info": { price: { mode: "dynamic", currency: "USD" }, protocols: [{ x402: {} }] },
        "x-pricing": { unit: "USD per digest", formula: "base + per_handle * handles (+media surcharge)",
          base: digestBaseUsd, perHandle: digestPerHandleUsd, mediaSurcharge: digestMediaUsd, note: "1-20 handles" },
        requestBody: { required: true, content: { "application/json": { example: xDigestExample, schema: xDigestSchema } } },
        responses: { "200": { description: "Structured digest", content: { "application/json": { example: { object: "x.digest", handles: [{ handle: "base", silent: false, themes: ["gas upgrade"], posts: [{ url: "https://x.com/base/status/123", summary: "...", likes: 4200, reposts: 890 }] }] } } } },
          "400": { description: "Invalid request" },
          "402": paidResponses["402"], "502": { description: "Search upstream unavailable or invalid model response" } },
      } } } : {}),
      ...(xSearchEnabled ? { "/v1/x/sentiment": { post: { summary: "X sentiment for a topic", operationId: "xSentiment",
        description: "Two x_search passes (Top + Latest) over the look-back window; every fetched post is classified bullish/bearish/neutral. score and distribution are model-estimated aggregates; low_sample is flagged when few posts were evaluated.",
        security: [{ x402: [] }],
        "x-worked-example": workedExample("POST", "/v1/x/sentiment", xSentimentExample, true),
        "x-payment-info": { price: { mode: "dynamic", currency: "USD" }, protocols: [{ x402: {} }] },
        "x-pricing": { unit: "USD per assessment", formula: "base + per_example * max_examples + per_day * extra_window_days",
          base: sentimentBaseUsd, perExample: sentimentPerExampleUsd, perDay: sentimentPerDayUsd, note: "window default 24h, max 168h" },
        requestBody: { required: true, content: { "application/json": { example: xSentimentExample, schema: xSentimentSchema } } },
        responses: { "200": { description: "Structured sentiment", content: { "application/json": { example: { object: "x.sentiment", topic: "x402 protocol", verdict: "bullish", score: 0.6, distribution: { bullish: 14, bearish: 3, neutral: 5 }, posts_evaluated: 22, drivers: ["agent payments momentum"], examples: [{ url: "https://x.com/user/status/123", stance: "bullish", snippet: "...", likes: 420 }] } } } },
          "400": { description: "Invalid request" },
          "402": paidResponses["402"], "502": { description: "Search upstream unavailable or invalid model response" } },
      } } } : {}),
      ...(xSearchEnabled ? { "/v1/x/factcheck": { post: { summary: "Factcheck a claim (X + web)", operationId: "xFactcheck",
        description: "Cross-checks a claim with server-side x_search (X posts) and web_search (press/official sources). verdict is confirmed|refuted|mixed|unverified; confidence is the model's self-assessment (low|medium|high).",
        security: [{ x402: [] }],
        "x-worked-example": workedExample("POST", "/v1/x/factcheck", xFactcheckExample, true),
        "x-payment-info": { price: { mode: "dynamic", currency: "USD" }, protocols: [{ x402: {} }] },
        "x-pricing": { unit: "USD per factcheck", formula: "base + per_source * max_sources",
          base: factcheckBaseUsd, perSource: factcheckPerSourceUsd, note: "max_sources caps evidence items per side" },
        requestBody: { required: true, content: { "application/json": { example: xFactcheckExample, schema: xFactcheckSchema } } },
        responses: { "200": { description: "Structured factcheck", content: { "application/json": { example: { object: "x.factcheck", claim: "...", verdict: "confirmed", confidence: "high", summary: "...", evidence_for: [{ url: "https://x.com/user/status/123", source_type: "x", note: "..." }], evidence_against: [] } } } },
          "400": { description: "Invalid request" },
          "402": paidResponses["402"], "502": { description: "Search upstream unavailable or invalid model response" } },
      } } } : {}),
      ...(agentsExecuteEnabled ? { "/v1/agents/execute": { post: { summary: "Autonomous agent execution", operationId: "executeAgent",
        description: "Sends a natural-language task to a multi-step agent engine (cheap agents/oss-20b or premium agents/gpt-6-sol) with calculator, fetch_url, web_search, data_analysis" + (codeExecEnabled ? " and sandboxed code_exec (python/javascript/typescript)" : "") + " tools. stream=true streams SSE step events (open, step, done). Charged at the max_steps ceiling: settlement overhead + engine base ($0.002 / $0.004) + per-step ($0.0005 / $0.004)" + (codeExecEnabled ? " + code_exec $0.002 per call (max 3 per task)" : "") + ", default 8, maximum 20 steps. Returns the agent.execution object with the full step trace, sources, usage and charged_ceiling_usd. Per-step timeouts finalize as partial instead of 502.",
        security: [{ x402: [] }],
        "x-worked-example": workedExample("POST", "/v1/agents/execute", agentsExample, true),
        "x-payment-info": { price: { mode: "dynamic", currency: "USD" }, protocols: [{ x402: {} }] },
        "x-pricing": { unit: "USD per execution", input: 0.002, output: 0.0005, premiumInput: 0.004, premiumOutput: 0.004, note: codeExecEnabled ? "engine base + per step, max 20 steps; code_exec $0.002/call, max 3 per task" : "engine base + per step, max 20 steps" },
        requestBody: { required: true, content: { "application/json": { example: agentsExample } } },
        responses: { "200": { description: "agent.execution result", content: { "application/json": {
          example: { object: "agent.execution", model: "agents/oss-20b", status: "completed", steps_executed: 2,
            steps: [{ n: 1, thought: "Compute", action: "tool", tool_call: { name: "calculator", args: { expression: "0.12*340" } }, tool_result: "40.8" }],
            output: { result: "40.8" },
            usage: { input_tokens: 4603, output_tokens: 122, tools_invoked: 1, steps_executed: 2, cost_usd: 0 } },
        } } }, "400": { description: "Invalid request" },
          "402": paidResponses["402"], "502": { description: "Engine unavailable" } },
      } } } : {}),
      "/v1/chat/completions": {
        post: {
          summary: "Create chat completion",
          description: CHAT_DESCRIPTION,
          operationId: "createChatCompletion",
          security: [{ x402: [] }],
          "x-worked-example": workedExample("POST", "/v1/chat/completions", { model: models[0]?.id, messages: [{ role: "user", content: "Hello" }], max_tokens: 8 }, true),
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
          "x-worked-example": workedExample("POST", "/api/v1/chat/completions", { model: models[0]?.id, messages: [{ role: "user", content: "Hello" }], max_tokens: 8 }, true),
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
          "x-worked-example": workedExample("POST", "/api/v1/responses", { model: models[0]?.id, input: "Hello", max_output_tokens: 8 }, true),
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
          "x-worked-example": workedExample("POST", "/v1/responses", { model: models[0]?.id, input: "Hello", max_output_tokens: 8 }, true),
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
      `- Minimum charge: $${config.minChargeUsd.toFixed(4)} per paid request (about $0.001 rounded)`,
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
      ...(speechEnabled ? [
        "",
        "POST " + origin + "/v1/audio/speech",
        "  Text-to-speech (paid; $" + speechPriceUsd.toFixed(3) + " per request): " + speechModels.join(", ") + ". WAV output.",
      ] : []),
      ...(transcriptionsEnabled ? [
        "POST " + origin + "/v1/audio/transcriptions",
        "  Speech-to-text (paid; $" + transcriptionPriceUsd.toFixed(3) + " per request): " + transcriptionModels.join(", ") +
          ". Multipart or JSON base64 input; whisper-large-v3* add word timestamps and srt/vtt.",
      ] : []),
     ...(jevEnabled ? ["", "POST " + origin + "/jev", "  Jev structured decisions ($" + jevPricePerMillion?.toFixed(2) + "/1M input tokens plus payment overhead). Send model=jev-latest, state and named questions with type and instructions."] : []),
      ...(xSearchEnabled ? ["", "POST " + origin + "/v1/x/search", "  Live X/Twitter search via Grok x_search. Price = $" + xSearchBasePriceUsd.toFixed(3) + " + $" + xSearchPerResultUsd.toFixed(4) + " per requested max_result (+$" + xSearchWebPriceUsd.toFixed(2) + " with include_web), plus payment overhead; $" + (xSearchBasePriceUsd + xSearchPerResultUsd * 10).toFixed(3) + " at the default 10 results. Body: {query, max_results?: 1..25, include_web?: bool, instructions?: string}. Returns the Grok answer with direct post citations."] : []),
      ...(xSearchEnabled ? [
        "POST " + origin + "/v1/x/digest",
        "  Digest of specific X handles: key posts with links, likes and reposts per handle, silent handles marked. Price = $" + digestBaseUsd.toFixed(3) + " + $" + digestPerHandleUsd.toFixed(3) + " per handle. Body: {handles, hours_back?: 1..168, max_posts_per_handle?: 1..5, include_media?: bool}.",
        "POST " + origin + "/v1/x/sentiment",
        "  X sentiment for a topic: verdict, -1..1 score, bullish/bearish/neutral distribution, drivers and evidence posts. Price = $" + sentimentBaseUsd.toFixed(3) + " + $" + sentimentPerExampleUsd.toFixed(4) + " per example + $" + sentimentPerDayUsd.toFixed(3) + " per extra day of window. Body: {topic, hours_back?: 1..168, max_examples?: 1..10, min_engagement?: int}.",
        "POST " + origin + "/v1/x/factcheck",
        "  Factcheck a claim against X posts and web sources: verdict (confirmed/refuted/mixed/unverified), confidence, evidence for and against. Price = $" + factcheckBaseUsd.toFixed(3) + " + $" + factcheckPerSourceUsd.toFixed(3) + " per source slot. Body: {claim, max_sources?: 1..10, days_back?: 1..30}.",
      ] : []),
      ...(agentsExecuteEnabled ? ["", "POST " + origin + "/v1/agents/execute", "  Autonomous agent execution with two engines (cheap agents/oss-20b, premium agents/gpt-6-sol):", "  multi-step reasoning with calculator, fetch_url, web_search, data_analysis" + (codeExecEnabled ? " and code_exec (sandboxed python/javascript/typescript)" : "") + " tools; stream=true streams SSE step events.", "  Ceiling = engine base ($0.002/$0.004) + per-step ($0.0005/$0.004)" + (codeExecEnabled ? " + code_exec $0.002/call (max 3 per task)" : "") + ", default 8, max 20 steps,", "  shown as charged_ceiling_usd. Step timeouts finalize as partial, never a bare 502."] : []),
      ...(embeddingsEnabled ? ["", "POST " + origin + "/v1/embeddings", "  Free NVIDIA embeddings with nvidia/nemotron-3-embed-1b."] : []),
      ...(freeGptOssEnabled ? [
        "",
        "POST " + origin + "/v1/free/chat/completions",
        "  Free nvidia/gpt-oss-20b chat completions (no payment). Rate-limited:",
        "  " + config.freeGptOssPer10Min + " requests/10min and " + config.freeGptOssPerDay + " requests/day per agent IP;",
        "  max_tokens capped at " + config.freeGptOssMaxTokens + ". Returns 429 free_tier_exhausted",
        "  with retry-after when the window is spent.",
        "GET " + origin + "/v1/free/chat/completions/quota",
        "  Current free-tier window usage for your IP (free).",
      ] : []),
      ...(nftEnabled ? ["", "GET " + origin + "/api/v1/{chainNetwork}/nft/getNFTMetadata?contractAddress=0x...", "  On-chain NFT contract metadata via Infura; $0.002 USDC per request.", "  Networks: " + Object.keys(nftNetworks).join(", ") + ". Returns name, symbol, contractURI and ERC interface support; unsupported fields are null."] : []),
      ...(prepaidCodesEnabled ? [
        "",
        "POST " + origin + "/prepaid/codes",
        "  Buy a prepaid API key for one GPT model (paid). Budget in 100000-token steps",
        "  from 100000 to 1000000, priced at the model input rate plus settlement fee.",
        "  The key works at https://mapleai.shop/v1 (OpenAI-compatible).",
        "GET https://mapleai.shop/v1/prepaid/status",
        "  Check prepaid key usage and status (free). Send the prepaid key as the",
        "  Bearer token; returns valid, reason and tokens total/used/reserved/remaining.",
      ] : []),
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
      ...(xSearchEnabled ? ["## X Search", "", "- " + xSearchModel + ": $" + xSearchBasePriceUsd.toFixed(3) + " base + $" + xSearchPerResultUsd.toFixed(4) + " x max_results (default 10, max 25); include_web adds $" + xSearchWebPriceUsd.toFixed(2),
        "- POST /v1/x/search with {query, max_results?: 1..25, include_web?: bool, instructions?: string}. Response is a Responses API object whose output_text summarizes the findings with direct post links.", ""] : []),
      ...(agentsExecuteEnabled ? ["## Agents", "", "- agents/oss-20b (cheap): $0.002 base + $0.0005 per step; agents/gpt-6-sol (premium): $0.004 base + $0.004 per step" + (codeExecEnabled ? "; code_exec $0.002 per call (max 3 per task)" : "") + "; charged at the max_steps ceiling (default 8, max 20), shown as charged_ceiling_usd",
        "- POST /v1/agents/execute with model, task, optional context, max_steps, tools (calculator, fetch_url, web_search, data_analysis" + (codeExecEnabled ? ", code_exec" : "") + ") and stream=true for SSE step events (open, step, done). Answers include the full step trace, fetched sources and token usage; step timeouts finalize as partial.", ""] : []),
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
      `${origin}/service-endpoints.json - one-shot machine-readable index of routes, access modes and pricing`,
      `${origin}/.well-known/x402 - x402 discovery document`,
      `${origin}/.well-known/agent-card.json - A2A agent card with skills`,
      `${origin}/openapi.json - OpenAPI 3.1 specification`,
      `${origin}/AI-AGENTS.md - integration guide for agents`,
      `${origin}/llms.txt - this file`,
      "",
    ].join("\n"),
  );
});

app.get("/health", (req: Request, res: Response) => {
  res.json({
    status: config.disabledModels.length > 0 ? "degraded" : "ok",
    service: config.serviceName,
    degradedModels: config.disabledModels,
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
