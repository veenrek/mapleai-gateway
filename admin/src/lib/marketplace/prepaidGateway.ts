import { authenticateMarketplaceBuyer } from "./auth";

export function isPrepaidGatewayRequest(request: Request): boolean {
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0];
  const rawHost = forwardedHost || request.headers.get("host") || new URL(request.url).host;
  return rawHost.trim().toLowerCase().replace(/:\d+$/, "") === "mapleai.shop";
}

export function authenticatePrepaidGatewayBuyer(request: Request) {
  const buyerKey = authenticateMarketplaceBuyer(request);
  return buyerKey?.tokenBudgetTotal != null || buyerKey?.isUnlimited ? buyerKey : null;
}
