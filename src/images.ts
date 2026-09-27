import type { NextFunction, Request, Response } from "express";
import { config } from "./config.js";
import { paymentOverheadUsd } from "./gas.js";

const allowedModels = new Set([
  "gpt-image-2",
  "gpt-image-2.5", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst",
  "grok-imagine-image", "gpt-image-2-2k", "gpt-image-2-4k",
  "gpt-image-2.5-flare-4k", "gpt-image-2.5-sunburst-2k", "gpt-image-2.5-sunburst-4k",
]);
type Rates = Record<string, Record<string, number>>;
export type ImageKind = "generation" | "edit";

function parseRates(raw: string | undefined): Rates {
  if (!raw) return {};
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("IMAGE_PRICES must be an object");
  const rates = value as Rates;
  for (const [model, sizes] of Object.entries(rates)) {
    if (!allowedModels.has(model) || (typeof sizes !== "number" && (!sizes || typeof sizes !== "object" || Array.isArray(sizes)))) {
      throw new Error("Invalid IMAGE_PRICES model: " + model);
    }
    if (typeof sizes === "number") {
      if (!Number.isFinite(sizes) || sizes <= 0) throw new Error("Invalid IMAGE_PRICES rate: " + model);
      rates[model] = { [defaultSize(model)]: sizes };
      continue;
    }
    for (const [size, price] of Object.entries(sizes)) {
      if (!/^\d{3,4}x\d{3,4}$/.test(size) || !Number.isFinite(price) || price <= 0) {
        throw new Error("Invalid IMAGE_PRICES rate: " + model + "/" + size);
      }
    }
  }
  return rates;
}

function defaultSize(model: string): string {
  if (model.includes("4k")) return "4096x4096";
  if (model.includes("2k")) return "2048x2048";
  return "1024x1024";
}

export const imageRates = parseRates(process.env.IMAGE_PRICES);
export const imageModels = Object.keys(imageRates);
export const imagesEnabled = Boolean(config.imageUpstreamApiKey && imageModels.length);

export interface ImageRequest {
  model: string;
  size: string;
  n: number;
  prompt: string;
  image?: Buffer;
  imageType?: string;
}

export function parseImageRequest(body: Record<string, unknown>, kind: ImageKind): ImageRequest | string {
  const { model, size, prompt } = body;
  const n = body.n ?? 1;
  if (typeof model !== "string" || !imageRates[model]) return "Unknown or unpriced image model";
  if (typeof size !== "string" || !imageRates[model][size]) return "Unsupported size for image model";
  if (!Number.isInteger(n) || (n as number) < 1 || (n as number) > 4) return "n must be an integer from 1 to 4";
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 4000) return "prompt must be 1 to 4000 characters";
  const supported = kind === "edit" ? ["model", "size", "n", "prompt", "image"] : ["model", "size", "n", "prompt"];
  if (Object.keys(body).some((key) => !supported.includes(key))) return "Unsupported image request field";
  const result: ImageRequest = { model, size, n: n as number, prompt };
  if (kind === "edit") {
    if (typeof body.image !== "string") return "image must be a PNG, JPEG or WebP data URI";
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(body.image);
    if (!match || match[2].length > 14_000_000) return "image must be a PNG, JPEG or WebP data URI under 10 MB";
    const bytes = Buffer.from(match[2], "base64");
    if (bytes.length > 10_000_000 || bytes.length === 0 || bytes.toString("base64") !== match[2]) return "Invalid image data";
    const type = match[1];
    const valid = type === "image/png" ? bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
      : type === "image/jpeg" ? bytes.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))
      : bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP";
    if (!valid) return "Image content does not match its MIME type";
    result.image = bytes;
    result.imageType = type;
  }
  return result;
}

export function validateImage(kind: ImageKind) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!imagesEnabled) { res.status(503).json({ error: { message: "Image API is not configured" } }); return; }
    const parsed = parseImageRequest(req.body ?? {}, kind);
    if (typeof parsed === "string") { res.status(400).json({ error: { type: "invalid_request", message: parsed } }); return; }
    res.locals.imageRequest = parsed;
    next();
  };
}

export async function quoteImage(body: Record<string, unknown>): Promise<string> {
  const rate = imageRates[String(body.model ?? "")]?.[String(body.size ?? "")];
  const n = Number(body.n ?? 1);
  const overhead = await paymentOverheadUsd();
  if (!rate || !Number.isInteger(n) || n < 1 || n > 4) {
    return "$" + Math.max(config.minChargeUsd, overhead).toFixed(6);
  }
  return "$" + Math.max(config.minChargeUsd, rate * n + overhead).toFixed(6);
}

export async function fetchImage(req: ImageRequest, kind: ImageKind): Promise<globalThis.Response> {
  const key = config.imageUpstreamApiKey;
  if (!key) throw new Error("Image credential missing");
  let body: BodyInit;
  let path: string;
  const headers: Record<string, string> = { authorization: "Bearer " + key };
  if (kind === "generation") {
    path = "/images/generations";
    headers["content-type"] = "application/json";
    body = JSON.stringify({ model: req.model, size: req.size, n: req.n, prompt: req.prompt, response_mode: "sync" });
  } else {
    path = "/images/edits";
    const form = new FormData();
    form.set("model", req.model);
    form.set("size", req.size);
    form.set("n", String(req.n));
    form.set("prompt", req.prompt);
    form.set("image", new Blob([new Uint8Array(req.image!)], { type: req.imageType }), "image");
    body = form;
  }
  return fetch(config.upstreamBaseUrl + path, { method: "POST", headers, body, signal: AbortSignal.timeout(180_000) });
}
