import path from "node:path";
import os from "node:os";
import { safeHomedir } from "@/shared/utils/safeHomedir";

const CONFIG_PATH = path.join(safeHomedir(), ".config", "kilocode", "settings.json");

export function generateKilocodeConfig(options: {
  baseUrl: string;
  apiKey: string;
  model?: string;
}): string {
  let base = options.baseUrl;
  let end = base.length;
  while (end > 0 && base[end - 1] === "/") end--;
  base = end < base.length ? base.slice(0, end) : base;
  if (base.endsWith("/v1")) base = base.slice(0, -3);

  const config = {
    apiKey: options.apiKey,
    baseUrl: `${base}/v1`,
  };

  return JSON.stringify(config, null, 2);
}
