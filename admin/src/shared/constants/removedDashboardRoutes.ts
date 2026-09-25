/**
 * Marketplace-only build: dashboard routes whose pages were physically removed
 * from src/app/(dashboard)/dashboard. The sidebar (and any other consumer of
 * SIDEBAR_SECTIONS) filters these out at render time, so nothing links to 404.
 */
export const REMOVED_DASHBOARD_HREFS: ReadonlySet<string> = new Set([
  "/dashboard/a2a",
  "/dashboard/acp-agents",
  "/dashboard/activity",
  "/dashboard/agent-skills",
  "/dashboard/analytics",
  "/dashboard/api-manager",
  "/dashboard/api-endpoints",
  "/dashboard/audit",
  "/dashboard/auto-combo",
  "/dashboard/batch",
  "/dashboard/cache",
  "/dashboard/changelog",
  "/dashboard/cli-agents",
  "/dashboard/cli-code",
  "/dashboard/cloud-agents",
  "/dashboard/compression",
  "/dashboard/context",
  "/dashboard/context/settings",
  "/dashboard/context/combos",
  "/dashboard/free-provider-rankings",
  "/dashboard/free-tiers",
  "/dashboard/gamification",
  "/dashboard/leaderboard",
  "/dashboard/limits",
  "/dashboard/mcp",
  "/dashboard/media-providers",
  "/dashboard/memory",
  "/dashboard/omni-skills",
  "/dashboard/playground",
  "/dashboard/plugins",
  "/dashboard/quota",
  "/dashboard/runtime",
  "/dashboard/search-tools",
  "/dashboard/system",
  "/dashboard/tokens",
  "/dashboard/tools",
  "/dashboard/translator",
  "/dashboard/webhooks",
]);

export function isRemovedDashboardHref(href: string | undefined): boolean {
  return typeof href === "string" && REMOVED_DASHBOARD_HREFS.has(href);
}
