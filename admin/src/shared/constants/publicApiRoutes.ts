const PUBLIC_API_ROUTE_PREFIXES = [
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/status",
  // Public storefront: catalog + key checker (no auth by design).
  // Marketplace: каждый роут самозащищён внутри (management/buyer/seller/wallet).
  "/api/marketplace/",
  "/api/check-key",
  "/api/auth/wallet/nonce",
  "/api/auth/wallet/verify",
  "/api/storefront",
  "/api/init",
  "/api/v1/",
  "/api/cloud/",
  "/api/sync/bundle",
  "/api/oauth/",
  // Public, ticket-gated Codex device-flow completion (validate + persist).
  // The handler enforces its own single-use ticket check; no dashboard auth.
  "/api/codex/connect/",
  // Remote-mode bootstrap: exchange the management password for a scoped CLI
  // access token. The handler enforces its own password check + lockout — there
  // is no token yet at this point, so it cannot require management auth.
  "/api/cli/connect",
];

const PUBLIC_READONLY_API_ROUTE_PREFIXES = [
  "/api/monitoring/health",
  "/api/settings/require-login",
];

const PUBLIC_READONLY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function isPublicApiRoute(pathname: string, method = "GET"): boolean {
  if (PUBLIC_API_ROUTE_PREFIXES.some((route) => pathname.startsWith(route))) {
    return true;
  }

  if (!PUBLIC_READONLY_METHODS.has(String(method).toUpperCase())) {
    return false;
  }

  return PUBLIC_READONLY_API_ROUTE_PREFIXES.some((route) => pathname.startsWith(route));
}

export { PUBLIC_API_ROUTE_PREFIXES, PUBLIC_READONLY_API_ROUTE_PREFIXES, PUBLIC_READONLY_METHODS };
