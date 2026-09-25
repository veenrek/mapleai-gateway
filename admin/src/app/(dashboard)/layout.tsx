import Link from "next/link";

/**
 * Marketplace admin shell — собственный минималистичный каркас вместо
 * старого DashboardLayout/Sidebar. Верхняя навигация + контент.
 */

const NAV = [
  { href: "/dashboard/marketplace", label: "Marketplace" },
  { href: "/dashboard/combos", label: "Combos" },
  { href: "/dashboard/providers", label: "Providers" },
  { href: "/dashboard/proxies", label: "Proxies" },
  { href: "/dashboard/prepaid", label: "Prepaid" },
  { href: "/dashboard/logs", label: "Logs" },
  { href: "/dashboard/settings", label: "Settings" },
];

export default function DashboardRootLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-text-main">
      <header className="sticky top-0 z-40 border-b border-border bg-surface/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
          <div className="flex items-center gap-6">
            <span className="text-base font-bold tracking-tight">MapleAI</span>
            <nav className="flex items-center gap-4">
              {NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="text-sm text-text-muted transition-colors hover:text-text-main"
                >
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>
          <span className="rounded-full bg-green-500/10 px-3 py-1 text-xs text-green-600 dark:text-green-400">
            owner
          </span>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
    </div>
  );
}
