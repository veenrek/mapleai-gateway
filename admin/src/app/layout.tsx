import { Inter } from "next/font/google";
// CSS pipeline workaround: globals.css is precompiled to /generated-theme.css
// (Tailwind v4 CLI) because the webpack css chain fails on this deployment.
// Regenerate: npx @tailwindcss/cli -i src/app/globals.css -o public/generated-theme.css
import { ThemeProvider } from "@/shared/components/ThemeProvider";
import { NextIntlClientProvider } from "next-intl";
import { getMessages, getLocale } from "next-intl/server";
import { RTL_LOCALES } from "@/i18n/config";
import { normalizeComplianceEventTypes } from "@/i18n/request";
import { getSettings } from "@/lib/db/settings";
import type { Viewport } from "next";
import { PwaRegister } from "@/shared/components/PwaRegister";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

export const viewport: Viewport = {
  themeColor: "#0b0f1a",
  viewportFit: "cover",
};

export async function generateMetadata() {
  const settings = await getSettings();
  const instanceName = settings?.instanceName || "MapleAI";
  const customFaviconUrl = settings?.customFaviconUrl || settings?.customFaviconBase64;
  const siteUrl = (process.env.PUBLIC_SITE_URL || "").trim();

  return {
    ...(siteUrl ? { metadataBase: new URL(siteUrl) } : {}),
    title: {
      default: `${instanceName} — prepaid OpenAI-compatible AI API (GPT‑5.6)`,
      template: `%s — ${instanceName}`,
    },
    description:
      "Prepaid OpenAI‑compatible AI API marketplace: buy a token pack, get one API key, connect Codex CLI, OpenCode, VS Code or any OpenAI-compatible agent. Fast billing, transparent balance check.",
    keywords: [
      "AI API",
      "OpenAI compatible",
      "prepaid API key",
      "Codex CLI",
      "OpenCode",
      "GPT-5.6",
      "token metering",
    ],
    category: "developer tools",
    openGraph: {
      siteName: instanceName,
      title: `${instanceName} — prepaid OpenAI-compatible AI API`,
      description:
        "One API key for Codex, OpenCode, VS Code and Hermes. Prepaid token packs, crypto payments, no subscriptions.",
      type: "website",
      ...(siteUrl ? { url: siteUrl } : {}),
      images: [{ url: "/icon-512.png", width: 512, height: 512, alt: instanceName }],
    },
    twitter: {
      card: "summary",
      title: `${instanceName} — prepaid OpenAI-compatible AI API`,
      description:
        "One API key for Codex, OpenCode, VS Code and Hermes — prepaid token packs.",
      images: ["/icon-512.png"],
    },
    alternates: {
      canonical: "/",
    },
    robots: {
      index: true,
      follow: true,
      googleBot: { index: true, follow: true, noimageindex: false },
    },
    manifest: "/manifest.webmanifest",
    applicationName: instanceName,
    appleWebApp: {
      capable: true,
      title: instanceName,
      statusBarStyle: "black-translucent",
    },
    other: {
      "mobile-web-app-capable": "yes",
    },
    icons: {
      icon: customFaviconUrl
        ? "/api/settings/favicon"
        : [
            { url: "/favicon.ico", sizes: "any" },
            { url: "/favicon.svg", type: "image/svg+xml" },
            { url: "/icon-512.png", type: "image/png", sizes: "512x512" },
          ],
      apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
    },
  };
}

export default async function RootLayout({ children }) {
  const locale = await getLocale();
  const messages = normalizeComplianceEventTypes((await getMessages()) as Record<string, unknown>);
  const isRtl = RTL_LOCALES.includes(locale as (typeof RTL_LOCALES)[number]);

  return (
    <html lang={locale} dir={isRtl ? "rtl" : "ltr"} suppressHydrationWarning>
      <head>
        <link rel="stylesheet" href="/generated-theme.css" />
        {/* Material Symbols icon font is self-hosted via globals.css
            (@import "material-symbols/outlined.css") so icons render even when
            the Google Fonts CDN is unreachable (#3695). */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              if (typeof window !== 'undefined') {
                if (!window.crypto) {
                  window.crypto = {};
                }
                if (!window.crypto.randomUUID) {
                  window.crypto.randomUUID = function() {
                    if (window.crypto.getRandomValues) {
                      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
                        const r = window.crypto.getRandomValues(new Uint8Array(1))[0] % 16;
                        const v = c === 'x' ? r : (r & 0x3 | 0x8);
                        return v.toString(16);
                      });
                    }
                    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
                      const r = Math.random() * 16 | 0;
                      const v = c === 'x' ? r : (r & 0x3 | 0x8);
                      return v.toString(16);
                    });
                  };
                }
              }
              try {
                const stored = localStorage.getItem('theme');
                const parsed = stored ? JSON.parse(stored) : null;
                const theme = parsed?.state?.theme || 'system';
                if (theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
                  document.documentElement.classList.add('dark');
                } else {
                  document.documentElement.classList.remove('dark');
                }
              } catch (e) {}
            `,
          }}
        />
      </head>
      <body className={`${inter.variable} font-sans antialiased`} suppressHydrationWarning>
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:px-4 focus:py-2 focus:bg-[#6366f1] focus:text-white focus:rounded-lg focus:text-sm focus:font-semibold focus:shadow-lg"
        >
          Skip to content
        </a>
        <NextIntlClientProvider locale={locale} messages={messages}>
          <PwaRegister />
          <ThemeProvider>{children}</ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
