import { config } from "./config.js";

const credentialFailures = new Set([401, 402, 403, 429]);

export async function fetchUpstreamChat(body: string): Promise<Response> {
  const keys = [config.upstreamApiKey, config.backupUpstreamApiKey]
    .filter((key, index, values): key is string => Boolean(key) && values.indexOf(key) === index);
  for (const [index, key] of keys.entries()) {
    const response = await fetch(config.upstreamBaseUrl + "/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + key },
      body,
    });
    if (response.ok || index === keys.length - 1 || !credentialFailures.has(response.status)) {
      return response;
    }
    await response.body?.cancel();
    console.warn("[upstream] primary credential failed with HTTP " + response.status + "; trying backup");
  }
  throw new Error("No upstream credential configured");
}
