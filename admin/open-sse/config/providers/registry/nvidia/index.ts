import type { RegistryEntry } from "../../shared.ts";

export const nvidiaProvider: RegistryEntry = {
  id: "nvidia",
  alias: "nvidia",
  format: "openai",
  executor: "default",
  baseUrl: "https://integrate.api.nvidia.com/v1/chat/completions",
  authType: "apikey",
  authHeader: "bearer",
  toolNameMaxLength: 64,
  // nvidia multiplexes many models behind ONE connection — a renamed/unavailable
  // model 404s only the model, not the whole account (accountFallback per-model quota).
  passthroughModels: true,
  models: [
    // Sweep 2026-09-27: every entry below passed a live inference probe through
    // the connection test route. Removed entries returned 410 Gone or 404 from
    // NVIDIA NIM: z-ai/glm-5.1, minimaxai/minimax-m3, minimaxai/minimax-m2.7,
    // mistralai/mistral-small-4-119b-2603, mistralai/mistral-large-3-675b-instruct-2512,
    // mistralai/devstral-2-123b-instruct-2512, qwen/qwen3.5-397b-a17b,
    // qwen/qwen3.5-122b-a10b, stepfun-ai/step-3.5-flash, stepfun-ai/step-3.7-flash,
    // deepseek-ai/deepseek-v4-pro, deepseek-ai/deepseek-v4-flash,
    // moonshotai/kimi-k2.6 (catalog-listed but 404 on inference), openai/gpt-oss-120b.
    { id: "google/gemma-4-31b-it", name: "Gemma 4 31B" },
    { id: "openai/gpt-oss-20b", name: "GPT OSS 20B", toolCalling: false },
    { id: "nvidia/nemotron-3-super-120b-a12b", name: "Nemotron 3 Super 120B A12B" },
  ],
};
