import createNextIntlPlugin from "next-intl/plugin";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");
const distDir = process.env.NEXT_DIST_DIR || ".build/next";
const projectRoot = dirname(fileURLToPath(import.meta.url));
const scriptSrc =
  process.env.NODE_ENV === "development"
    ? "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:"
    : "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:";
const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  scriptSrc,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob: https:",
  "media-src 'self' data: blob:",
  "connect-src 'self' http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:* https: wss:",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
].join("; ");
const securityHeaders = [
  {
    key: "Content-Security-Policy",
    value: contentSecurityPolicy,
  },
  {
    key: "X-Frame-Options",
    value: "DENY",
  },
  {
    key: "X-Content-Type-Options",
    value: "nosniff",
  },
  {
    key: "Referrer-Policy",
    value: "strict-origin-when-cross-origin",
  },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=()",
  },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
];

function isNextIntlExtractorDynamicImportWarning(warning) {
  const message = typeof warning === "string" ? warning : warning?.message || "";
  const resource = warning?.module?.resource || warning?.file || "";
  const target = "next-intl/dist/esm/production/extractor/format/index.js";
  return (
    resource.includes(target) &&
    (message.includes("import(t)") || message.includes("dependency is an expression"))
  );
}

// OMNIROUTE_BUILD_PROFILE=minimal physically removes four optional privileged
// modules (MITM cert install, Zed keychain import, Cloud Sync, 9router
// installer) from the built bundle by aliasing them to feature-disabled stubs.
// The resulting artifact is intended to be published as `omniroute-secure`
// for security-sensitive environments. See docs/security/SOCKET_DEV_FINDINGS.md.
const isMinimalBuild = process.env.OMNIROUTE_BUILD_PROFILE === "minimal";

const minimalBuildAliases = isMinimalBuild
  ? {
      "@/mitm/cert/install": "./src/mitm/cert/install.stub.ts",
      "@/lib/zed-oauth/keychain-reader": "./src/lib/zed-oauth/keychain-reader.stub.ts",
      "@/lib/cloudSync": "./src/lib/cloudSync.stub.ts",
      "@/lib/services/installers/ninerouter": "./src/lib/services/installers/ninerouter.stub.ts",
    }
  : {};

/** @type {import('next').NextConfig} */
const nextConfig = {
  distDir,
  // Turbopack config: redirect native modules to stubs at build time
  turbopack: {
    root: projectRoot,
    resolveAlias: {
      // Point mitm/manager to a stub during build (native child_process/fs can't be bundled)
      "@/mitm/manager": "./src/mitm/manager.stub.ts",
      ...minimalBuildAliases,
    },
  },
  output: "standalone",
  compress: true,
  productionBrowserSourceMaps: false,
  // OmniRoute is a proxy for AI APIs — request bodies routinely include
  // multi-MB payloads (vision models, image edits, base64-encoded files,
  // long chat histories with embedded images). Next.js's Server Action
  // handler intercepts POSTs with multipart/form-data or
  // x-www-form-urlencoded content-types and enforces a 1 MB cap that
  // surfaces as a 413 with a confusing "Server Actions" hint, even on
  // pure route handlers. 50 MB matches what most upstream LLM providers
  // accept for image-bearing requests; tune via env if a deployment needs
  // more.
  experimental: {
    serverActions: {
      bodySizeLimit: process.env.OMNIROUTE_SERVER_ACTIONS_BODY_LIMIT || "50mb",
    },
    // Next.js proxy (middleware) has a default 10MB body clone limit. File
    // uploads (OpenAI-compatible /v1/files) routinely exceed this. Match the
    // 512 MB server-side cap; tune via env if needed.
    proxyClientMaxBodySize: process.env.NEXT_PROXY_BODY_LIMIT || "512mb",
    // PR-2 of diegosouzapw/OmniRoute#3932: tree-shake barrel re-exports so
    // route bundles don't pull in 14 locale files, every lucide-react icon,
    // or the full date-fns surface when only one helper is used.
    optimizePackageImports: [
      "lobehub/icons",
      "@lobehub/icons",
      "lucide-react",
      "date-fns",
      "lodash",
      "lodash-es",
      "material-symbols",
      "next-intl",
      "@omniroute/open-sse",
    ],
  },
  outputFileTracingRoot: projectRoot,
  outputFileTracingIncludes: {
    // Migration SQL and compression rule/filter JSON files are read via fs at
    // runtime and are NOT always auto-traced by webpack/turbopack.
    "/*": [
      "./src/lib/db/migrations/**/*",
      "./src/mitm/server.cjs",
      "./open-sse/services/compression/engines/rtk/filters/**/*.json",
      "./open-sse/services/compression/rules/**/*.json",
      "./open-sse/lib/sha3_wasm_bg.wasm",
      "./open-sse/lib/deepseek-pow-solver.cjs",
    ],
  },
  outputFileTracingExcludes: {
    // Planning/task docs are not runtime assets and can break standalone copies
    // when broad fs/path tracing pulls the whole repository into the NFT graph.
    "/*": [
      "./.git/**/*",
      "./_tasks/**/*",
      "./_references/**/*",
      "./_ideia/**/*",
      "./_mono_repo/**/*",
      "./coverage/**/*",
      "./test-results/**/*",
      "./playwright-report/**/*",
      "./app.__qa_backup/**/*",
      "./tests/**/*",
      "./logs/**/*",
    ],
  },
  serverExternalPackages: [
    "pino",
    "pino-pretty",
    "thread-stream",
    "pino-abstract-transport",
    "better-sqlite3",
    // sqlite-vec ships a native vec0.so loaded at runtime via createRequire().
    // Turbopack otherwise tries to bundle the .so and fails with "Unknown module
    // type"; externalizing it keeps the require at runtime (like better-sqlite3).
    // See issue #3066.
    "sqlite-vec",
    "node-machine-id",
    "keytar",
    "wreq-js",
    "zod",
    "tls-client-node",
    "koffi",
    "tough-cookie",
    "@ngrok/ngrok",
    "@huggingface/transformers",
    "child_process",
    "fs",
    "path",
    "os",
    "crypto",
    "net",
    "tls",
    "http",
    "https",
    "stream",
    "buffer",
    "util",
    "process",
  ],
  transpilePackages: ["@omniroute/open-sse", "@lobehub/icons", "fumadocs-ui", "fumadocs-core"],
  allowedDevOrigins: ["localhost", "127.0.0.1", "192.168.0.250"],
  typescript: {
    // TODO: Re-enable after fixing all sub-component useTranslations scope issues
    ignoreBuildErrors: true,
  },
  webpack(config, { webpack }) {
    config.ignoreWarnings = [
      ...(config.ignoreWarnings || []),
      isNextIntlExtractorDynamicImportWarning,
    ];
    config.optimization = config.optimization || {};
    config.optimization.splitChunks = {
      ...config.optimization.splitChunks,
      cacheGroups: {
        ...(config.optimization.splitChunks?.cacheGroups || {}),
        recharts: {
          test: /[\\/]node_modules[\\/]recharts[\\/]/,
          name: "vendor-recharts",
          chunks: "all",
          priority: 20,
        },
        lobeIcons: {
          test: /[\\/]node_modules[\\/]@lobehub[\\/]icons[\\/]/,
          name: "vendor-lobe-icons",
          chunks: "all",
          priority: 20,
        },
        monaco: {
          test: /[\\/]node_modules[\\/]monaco-editor[\\/]/,
          name: "vendor-monaco",
          chunks: "all",
          priority: 20,
        },
        xyflow: {
          test: /[\\/]node_modules[\\/]@xyflow[\\/]/,
          name: "vendor-xyflow",
          chunks: "all",
          priority: 20,
        },
        mermaid: {
          test: /[\\/]node_modules[\\/]mermaid[\\/]/,
          name: "vendor-mermaid",
          chunks: "all",
          priority: 20,
        },
        // PR-2 of diegosouzapw/OmniRoute#3932: isolate the heavy long-tail
        // vendor chunks that only some routes actually need, so dashboard
        // pages don't pay for the docs bundle (or vice versa).
        nextIntl: {
          test: /[\\/]node_modules[\\/]next-intl[\\/]/,
          name: "vendor-next-intl",
          chunks: "all",
          priority: 25,
        },
        fumadocs: {
          test: /[\\/]node_modules[\\/](fumadocs-ui|fumadocs-core|fumadocs-mdx)[\\/]/,
          name: "vendor-fumadocs",
          chunks: "all",
          priority: 20,
        },
        comboGraph: {
          test: /[\\/]node_modules[\\/]@?dagre[\\/]|[\\/]node_modules[\\/]@?elkjs[\\/]/,
          name: "vendor-combo-graph",
          chunks: "all",
          priority: 20,
        },
      },
    };

    if (isMinimalBuild) {
      // Mirror the turbopack.resolveAlias entries for webpack-built artifacts.
      // NormalModuleReplacementPlugin swaps the real module for a stub before
      // webpack resolves it, so the privileged source files are never compiled
      // into the standalone output.
      const replacements = [
        [/^@\/mitm\/cert\/install$/, "./src/mitm/cert/install.stub.ts"],
        [/^@\/lib\/zed-oauth\/keychain-reader$/, "./src/lib/zed-oauth/keychain-reader.stub.ts"],
        [/^@\/lib\/cloudSync$/, "./src/lib/cloudSync.stub.ts"],
        [
          /^@\/lib\/services\/installers\/ninerouter$/,
          "./src/lib/services/installers/ninerouter.stub.ts",
        ],
      ];
      for (const [pattern, stubPath] of replacements) {
        config.plugins.push(
          new webpack.NormalModuleReplacementPlugin(pattern, (resource) => {
            resource.request = stubPath;
          })
        );
      }
    }

    return config;
  },
  images: {
    unoptimized: true,
  },

  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
      // G-10: allow OmniRoute's own dashboard to embed the 9Router UI via our reverse proxy.
      // `frame-ancestors 'self'` overrides the global `frame-ancestors 'none'` only for this
      // path. The route is already LOCAL_ONLY (routeGuard.ts) so remote origins cannot reach it.
      {
        source: "/dashboard/providers/services/:name/embed/:path*",
        headers: [{ key: "Content-Security-Policy", value: "frame-ancestors 'self'" }],
      },
    ];
  },

  async redirects() {
    return [
      // Dashboard routes
      {
        source: "/dashboard/skills",
        destination: "/dashboard/omni-skills",
        permanent: true,
      },
      // Architecture
      // Guides
      // Reference
      // Frameworks
      // Routing
      // Security
      // Compression
      // Ops
      // CLI Pages — Plano 14 (F9)
      { source: "/dashboard/cli-tools", destination: "/dashboard/cli-code", permanent: true },
      {
        source: "/dashboard/cli-tools/:path*",
        destination: "/dashboard/cli-code/:path*",
        permanent: true,
      },
      { source: "/dashboard/agents", destination: "/dashboard/acp-agents", permanent: true },
      {
        source: "/dashboard/agents/:path*",
        destination: "/dashboard/acp-agents/:path*",
        permanent: true,
      },
    ];
  },

  async rewrites() {
    return [
      {
        source: "/chat/completions",
        destination: "/api/v1/chat/completions",
      },
      {
        source: "/responses",
        destination: "/api/v1/responses",
      },
      {
        source: "/responses/:path*",
        destination: "/api/v1/responses/:path*",
      },
      {
        source: "/models",
        destination: "/api/v1/models",
      },
      {
        source: "/v1/v1/:path*",
        destination: "/api/v1/:path*",
      },
      {
        source: "/v1/v1",
        destination: "/api/v1",
      },
      {
        source: "/codex/:path*",
        destination: "/api/v1/responses",
      },
      {
        source: "/v1/:path*",
        destination: "/api/v1/:path*",
      },
      {
        source: "/v1",
        destination: "/api/v1",
      },
      {
        source: "/v1beta/:path*",
        destination: "/api/v1beta/:path*",
      },
      {
        source: "/v1beta",
        destination: "/api/v1beta",
      },
    ];
  },
};

export default withNextIntl(nextConfig);
