import { config } from "./config.js";

const credentialFailures = new Set([401, 402, 403, 429]);

function comboPathModel(model: unknown): string | undefined {
  if (typeof model !== "string") return undefined;
  return config.comboUpstreamModels.includes(model) ? model : undefined;
}

export async function fetchUpstreamChat(body: string): Promise<Response> {
  const keys = [config.upstreamApiKey, config.backupUpstreamApiKey]
    .filter((key, index, values): key is string => Boolean(key) && values.indexOf(key) === index);
  for (const [index, key] of keys.entries()) {
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      payload = undefined;
    }
    const comboModel = payload && typeof payload === "object"
      ? comboPathModel((payload as { model?: unknown }).model)
      : undefined;
    const viaCombo = comboModel !== undefined && config.internalComboKey !== undefined;
    const response = await fetch(
      (viaCombo ? config.comboUpstreamBaseUrl : config.upstreamBaseUrl) + "/chat/completions",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + (viaCombo ? config.internalComboKey : key),
        },
        body,
      },
    );
    if (response.ok || index === keys.length - 1 || !credentialFailures.has(response.status)) {
      return response;
    }
    await response.body?.cancel();
    console.warn("[upstream] primary credential failed with HTTP " + response.status + "; trying backup");
  }
  throw new Error("No upstream credential configured");
}
