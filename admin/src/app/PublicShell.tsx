"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ReactNode } from "react";

const NAV_ITEMS = [
  { href: "/", label: "Check key" },
  { href: "/buy/gemini-pro", label: "🛒 Buy Gemini Pro AI 18 Months" },
  { href: "/connect", label: "How to connect" },
];

export default function PublicShell({
  children,
  actions,
}: {
  children: ReactNode;
  actions?: ReactNode;
}) {
  const pathname = usePathname();

  return (
    <div className="flex min-h-screen flex-col bg-bg text-text-main">
      <header className="sticky top-0 z-50 border-b border-border bg-bg/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-4 px-6">
          <Link
            href="/"
            className="shrink-0 text-lg font-semibold tracking-tight transition-colors hover:text-primary"
          >
            MapleAI
          </Link>

          <div className="flex items-center gap-3">
            <nav className="flex items-center gap-1">
              {NAV_ITEMS.map((item) => {
                const isActive = pathname === item.href;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`rounded-control px-3 py-2 text-sm font-medium transition-colors ${
                      isActive
                        ? "bg-surface-2 text-text-main"
                        : "text-text-muted hover:bg-surface-2/60 hover:text-text-main"
                    }`}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </nav>
            {actions}
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-12">{children}</main>

      <footer className="border-t border-border py-6">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 text-sm text-text-muted">
          <span>MapleAI</span>
          <span>Prepaid access to OpenAI-compatible models</span>
        </div>
      </footer>
    </div>
  );
}
