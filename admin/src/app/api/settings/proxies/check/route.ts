import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { parseProxyUrl } from "@/lib/db/proxies";
import { SAFE_OUTBOUND_FETCH_PRESETS, safeOutboundFetch } from "@/shared/network/safeOutboundFetch";
import { getProviderOutboundGuard } from "@/shared/network/outboundUrlGuard";

const DEFAULT_TARGET = "https://api.openai.com/";

// POST /api/settings/proxies/check - probe whether a proxy URL actually works
export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  let body: { proxyUrl?: unknown; targetUrl?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const proxyUrl = typeof body.proxyUrl === "string" ? body.proxyUrl.trim() : "";
  if (!proxyUrl) {
    return NextResponse.json({ error: "proxyUrl is required" }, { status: 400 });
  }
  const proxy = parseProxyUrl(proxyUrl);
  if (!proxy) {
    return NextResponse.json(
      { error: "Invalid proxy URL — use http://user:pass@host:port" },
      { status: 400 }
    );
  }

  let target = DEFAULT_TARGET;
  if (typeof body.targetUrl === "string" && body.targetUrl.trim()) {
    try {
      const parsed = new URL(body.targetUrl.trim());
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        target = parsed.toString();
      }
    } catch {
      // keep default target
    }
  }

  try {
    const res = await safeOutboundFetch(target, {
      ...SAFE_OUTBOUND_FETCH_PRESETS.validationRead,
      guard: getProviderOutboundGuard(),
      proxyConfig: proxy,
      allowRedirect: true,
    });
    return NextResponse.json({ ok: true, status: res.status });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Proxy check failed";
    return NextResponse.json({ ok: false, error: message });
  }
}
