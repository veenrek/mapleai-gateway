import express, { type Request, type Response } from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { HTTPFacilitatorClient, type HTTPRequestContext } from "@x402/core/server";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

type DynamicPrice = (context: HTTPRequestContext) => string | Promise<string>;
import { config } from "./config.js";
import { catalog, compactTokens, maxContextWindow, minInputPrice, money } from "./catalog.js";
import { chainInfo } from "./chain.js";
import { canonicalModelId, upstreamModelId } from "./models.js";
import { estimateOutputTokens, quotePrice, quoteBreakdown } from "./pricing.js";
import { actualCostUsd, extractPayer, parseUsage, parseUsageFromSse, recordUsage } from "./ledger.js";
import {
  toChatRequest,
  toResponsesObject,
  toResponsesSse,
  type ResponsesRequestBody,
} from "./responses.js";
import { docVars, render } from "./templates.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "../public");

const chain = chainInfo(config.network);
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);
app.use(express.json({ limit: "10mb" }));

// ---------------------------------------------------------------------------
// x402 resource server
// ---------------------------------------------------------------------------

const facilitator = new HTTPFacilitatorClient({ url: config.facilitatorUrl });
const resourceServer = new x402ResourceServer(facilitator).register(
  config.network,
  config.network.startsWith("solana:") ? new ExactSvmScheme() : new ExactEvmScheme(),
);

/** Parsed request body (express.json() runs first, and the paywall needs it to price). */
function requestBody(context: HTTPRequestContext): Record<string, unknown> {
  const adapter = context.adapter as unknown as {
    getBody?: () => unknown;
    req?: Request;
  };
  const body = typeof adapter.getBody === "function" ? adapter.getBody() : adapter.req?.body;
  return (body ?? {}) as Record<string, unknown>;
}

const quotedPrice: DynamicPrice = (context) => quotePrice(requestBody(context) as never);

/**
 * `quote` extension: BlockRun-style transparency in every 402 — the challenge
 * carries the counted input tokens, assumed output tokens and total price, and
 * each accepts entry gets a human-readable description with the breakdown.
 */
resourceServer.registerExtension({
  key: "quote",
  dynamicInfoFields: ["inputTokens", "outputTokens", "price"],
  async enrichPaymentRequiredResponse(_declaration, context) {
    const transport = context.transportContext as { request?: HTTPRequestContext } | undefined;
    const body = transport?.request ? requestBody(transport.request) : {};
    const quote = quoteBreakdown(body as { model?: string });

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

const CATALOG_SUMMARY = () => `${catalog().length} GPT models, OpenAI-compatible`;

/** Every paid route shares one pricing rule; only the description differs. */
function paidRoute(description: string) {
  return {
    accepts: {
      scheme: "exact",
      price: quotedPrice,
      network: config.network,
      payTo: config.payTo,
      maxTimeoutSeconds: 120,
    },
    description,
    mimeType: "application/json",
    extensions: { quote: {} },
  };
}

const CHAT_DESCRIPTION =
  "OpenAI-compatible chat completion, priced by counted input tokens + max output tokens at per-model rates";

const PAID_ROUTES = {
  "POST /v1/chat/completions": paidRoute(CHAT_DESCRIPTION),
  "POST /api/v1/chat/completions": paidRoute(CHAT_DESCRIPTION),
  "POST /api/v1/responses": paidRoute(
    "OpenAI-compatible Responses API (alpha), translated to chat completions upstream",
  ),
  "POST /v1/responses": paidRoute(
    "OpenAI-compatible Responses API (alpha), translated to chat completions upstream",
  ),
};

app.use(paymentMiddleware(PAID_ROUTES, resourceServer));

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

function upstreamHeaders(): Record<string, string> {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${config.upstreamApiKey}`,
  };
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
  const quotedUsd = quotePrice(req.body);

  try {
    let upstream = await fetch(`${config.upstreamBaseUrl}/chat/completions`, {
      method: "POST",
      headers: upstreamHeaders(),
      body: buildBody(true),
    });

    // Some OpenAI-compatible providers reject stream_options; retry once without.
    if (upstream.status === 400 && wantsStream) {
      const sniff = await upstream.clone().text();
      if (sniff.includes("stream_options")) {
        upstream = await fetch(`${config.upstreamBaseUrl}/chat/completions`, {
          method: "POST",
          headers: upstreamHeaders(),
          body: buildBody(false),
        });
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
  const quotedUsd = quotePrice(req.body);

  try {
    const upstream = await fetch(`${config.upstreamBaseUrl}/chat/completions`, {
      method: "POST",
      headers: upstreamHeaders(),
      body: JSON.stringify(chatRequest),
    });
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

app.get("/AI-AGENTS.md", (req, res) =>
  sendDoc(req, res, "AI-AGENTS.md", "text/markdown; charset=utf-8"),
);

app.get("/robots.txt", (req, res) => sendDoc(req, res, "robots.txt", "text/plain; charset=utf-8"));

app.get("/sitemap.xml", (req, res) => sendDoc(req, res, "sitemap.xml", "application/xml"));

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
  res.json({
    object: "list",
    data: catalog().map((m) => ({
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
    })),
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
    facilitator: config.facilitatorUrl,
    contact: config.contactEmail,
    minimumChargeUsd: config.minChargeUsd,
    resources: [
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

app.get("/openapi.json", (req: Request, res: Response) => {
  const models = catalog();
  const origin = originOf(req);
  const modelIds = models.map((m) => m.id);

  const modelPricing = {
    type: "dynamic",
    calculation: "input_tokens * input_rate + max_tokens * output_rate, floored at the minimum charge",
    unit: "USD per 1M tokens",
    minimum_charge_usd: config.minChargeUsd,
    models: models.map((m) => ({
      id: m.id,
      input: m.pricing.input,
      output: m.pricing.output,
    })),
  };

  const paymentInfo = {
    price: {
      mode: "dynamic",
      currency: "USD",
      min: config.minChargeUsd.toFixed(6),
      max: "1000",
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

  res.json({
    openapi: "3.1.0",
    info: {
      title: config.serviceName,
      version: "1.0.0",
      description:
        `Pay-per-request GPT access via the x402 protocol on ${chain.networkName}. ` +
        `${models.length} models behind one OpenAI-compatible endpoint; no accounts, no API keys.`,
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
        facilitator: config.facilitatorUrl,
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
      `- Minimum charge: $${config.minChargeUsd.toFixed(3)} per paid request`,
      `- Contact: ${config.contactEmail}`,
      "",
      "## Endpoints",
      "",
      `POST ${baseUrl}/chat/completions`,
      "  OpenAI-compatible chat completions (paid).",
      "  Returns HTTP 402 with a PAYMENT-REQUIRED header when payment is required.",
      "  Price = input_tokens * input_rate + max_tokens * output_rate.",
      "",
      `POST ${origin}/api/v1/chat/completions`,
      "  Alias of the above, for agent crawlers (paid).",
      "",
      `POST ${origin}/api/v1/responses`,
      "  OpenAI-compatible Responses API, alpha (paid).",
      "",
      `GET ${baseUrl}/models`,
      "  List all available models with pricing (free).",
      "",
      "## Available Models",
      "",
      ...models.map(
        (m) =>
          `- ${m.id}\n  ${m.name}: $${money(m.pricing.input)}/1M in, $${money(m.pricing.output)}/1M out, ` +
          `${compactTokens(m.contextWindow)} context`,
      ),
      "",
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
    facilitator: config.facilitatorUrl,
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
