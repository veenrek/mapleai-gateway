import type { NextFunction, Request, Response } from "express";
import { config } from "./config.js";

export const embeddingModel = "nvidia/nemotron-3-embed-1b";
export const embeddingsEnabled = Boolean(config.nvidiaApiKey);

export function validateEmbedding(req: Request, res: Response, next: NextFunction): void {
  const body = req.body;
  const validInput = typeof body?.input === "string" || (Array.isArray(body?.input) && body.input.length > 0 && body.input.length <= 128 && body.input.every((item: unknown) => typeof item === "string"));
  if (!body || typeof body !== "object" || Array.isArray(body) || body.model !== embeddingModel || !validInput) {
    res.locals.embeddingFailure = {
      source: "validation",
      reason: !body || typeof body !== "object" || Array.isArray(body) ? "invalid_body"
        : body.model == null ? "missing_model"
        : body.model !== embeddingModel ? "unsupported_model" : "invalid_input",
      message: "Expected the NVIDIA embedding model and input text",
    };
    res.status(400).json({ error: { message: "Expected the NVIDIA embedding model and input text", type: "invalid_request" } });
    return;
  }
  next();
}

export async function fetchEmbeddings(body: Record<string, unknown>): Promise<globalThis.Response> {
  if (!config.nvidiaApiKey) throw new Error("NVIDIA embeddings credential unavailable");
  return fetch("https://integrate.api.nvidia.com/v1/embeddings", { method: "POST", headers: { authorization: "Bearer " + config.nvidiaApiKey, "content-type": "application/json" }, body: JSON.stringify({ ...body, model: embeddingModel }), signal: AbortSignal.timeout(120_000) });
}
