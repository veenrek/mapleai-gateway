import { NextResponse } from "next/server";
import {
  getRelayAccount,
  markRelayAccountError,
  markRelayAccountSuccess,
} from "@/lib/db/relayAccounts";
import { anthropicToOpenAI } from "@omniroute/open-sse/executors/relayPool/anthropicOpenAI";
import { resolveAccountBaseUrl } from "@omniroute/open-sse/executors/relayPool";
import {
  createProxyDispatcher,
  getDefaultDispatcher,
} from "@omniroute/open-sse/utils/proxyDispatcher";

type RouteContext = { params: Promise<{ id: string }> };

const TEST_BODY = {
  model: "probe",
  max_tokens: 16,
  messages: [{ role: "user", content: "Reply with the single word: ok" }],
};

/**
 * Probe a relay account with a tiny request. Verifies credentials, base URL,
 * and (optionally) that a specific model is served.
 */
export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const account = getRelayAccount(id);
  if (!account) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }

  let model: string | null = null;
  try {
    const body = await request.json().catch(() => ({}));
    model = (body as { model?: string }).model || account.model || null;
  } catch {
    model = account.model || null;
  }

  const startedAt = Date.now();
  try {
    let status: number;
    let responseText = "";

    if (account.providerType === "openai") {
      const openaiBody = anthropicToOpenAI(
        { ...TEST_BODY, stream: false, model: model || TEST_BODY.model },
        account
      );
      const response = await fetch(`${resolveAccountBaseUrl(account)}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${account.apiKey || ""}`,
        },
        body: JSON.stringify(openaiBody),
        dispatcher: account.proxyUrl
          ? createProxyDispatcher(account.proxyUrl)
          : getDefaultDispatcher(),
        signal: AbortSignal.timeout(20_000),
      } as RequestInit);
      status = response.status;
      responseText = await response.text();
    } else if (account.providerType === "codex") {
      // Codex probing requires a live JWT + TLS fingerprint; treat presence of
      // credentials as a config check and let the first real request validate.
      status = account.apiKey || account.codexRefreshToken ? 200 : 401;
      responseText = status === 200 ? "codex credentials present" : "missing codex credentials";
    } else {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "anthropic-version": process.env.ANTHROPIC_VERSION || "2023-06-01",
      };
      if (account.authHeader === "authorization") {
        headers["Authorization"] = `Bearer ${account.apiKey || ""}`;
      } else {
        headers[account.authHeader || "x-api-key"] = account.apiKey || "";
      }
      const response = await fetch(`${resolveAccountBaseUrl(account)}/v1/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...TEST_BODY, model: model || TEST_BODY.model, max_tokens: 16 }),
        dispatcher: account.proxyUrl
          ? createProxyDispatcher(account.proxyUrl)
          : getDefaultDispatcher(),
        signal: AbortSignal.timeout(20_000),
      } as RequestInit);
      status = response.status;
      responseText = await response.text();
    }

    const latencyMs = Date.now() - startedAt;
    const ok = status < 400;
    if (ok) {
      await markRelayAccountSuccess(account.id);
    } else {
      await markRelayAccountError(account.id, status, responseText.slice(0, 500), 0);
    }

    return NextResponse.json({
      ok,
      status,
      latencyMs,
      providerType: account.providerType,
      baseUrl: resolveAccountBaseUrl(account),
      responsePreview: responseText.slice(0, 400),
    });
  } catch (error) {
    const message = String((error as Error)?.message || error);
    await markRelayAccountError(account.id, 0, message, 0);
    return NextResponse.json(
      { ok: false, error: message, latencyMs: Date.now() - startedAt },
      { status: 200 }
    );
  }
}
