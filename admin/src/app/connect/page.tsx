"use client";

import PublicShell from "../PublicShell";

function Code({ children }: { children: string }) {
  return (
    <pre className="mt-1 overflow-x-auto rounded bg-black/10 p-3 font-mono text-[12px] leading-relaxed text-text-main dark:bg-white/10">
      {children}
    </pre>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="space-y-2 rounded-card border border-border bg-surface p-4">
      <h2 className="text-base font-semibold">{title}</h2>
      <div className="text-sm text-text-muted">{children}</div>
    </section>
  );
}

/**
 * /connect — public guide page: how to plug a prepaid key into
 * Codex, OpenCode, VS Code, Hermes and other OpenAI-compatible tools.
 */
export default function ConnectPage() {
  return (
    <PublicShell>
      <div className="mx-auto w-full max-w-3xl space-y-6">
        <div className="space-y-2 text-center">
          <h1 className="text-2xl font-bold tracking-tight">How to connect</h1>
          <p className="text-sm leading-relaxed text-text-muted">
            One key and one base URL for every tool.
          </p>
        </div>

        <Section id="base" title="Base parameters">
          <div className="grid grid-cols-[110px_1fr] gap-y-2 text-xs">
            <span>Base URL</span>
            <code className="font-mono text-text-main">
              {typeof window !== "undefined" ? window.location.origin : "https://mapleai.shop"}/v1
            </code>
            <span>API Key</span>
            <code className="font-mono text-text-main">oms_buy_… (your prepaid key)</code>
            <span>Model</span>
            <code className="font-mono text-text-main">gpt-5.6-sol</code>
          </div>
        </Section>

        <Section id="codex" title="1. Codex CLI">
          Edit <code className="font-mono">~/.codex/config.toml</code>:
          <Code>{`model = "gpt-5.6-sol"
model_provider = "mapleai"
preferred_auth_method = "apikey"

[model_providers.mapleai]
name = "MapleAI"
base_url = "https://mapleai.shop/v1"
wire_api = "responses"
env_key = "MAPLEAI_API_KEY"`}</Code>
          Environment variable before launch:
          <Code>{`# macOS/Linux:
export MAPLEAI_API_KEY="oms_buy_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"

# Windows PowerShell:
$env:MAPLEAI_API_KEY="oms_buy_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"`}</Code>
        </Section>

        <Section id="opencode" title="2. OpenCode">
          Edit <code className="font-mono">~/.config/opencode/opencode.json</code>:
          <Code>{`{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "mapleai": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "MapleAI",
      "options": {
        "baseURL": "https://mapleai.shop/v1",
        "apiKey": "oms_buy_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
      },
      "models": {
        "gpt-5.6-sol": { "name": "GPT-5.6 Sol (MapleAI)" }
      }
    }
  },
  "model": "mapleai/gpt-5.6-sol"
}`}</Code>
        </Section>

        <Section id="vscode" title="3. VS Code (via Continue)">
          Edit <code className="font-mono">%USERPROFILE%\\.continue\\config.yaml</code>:
          <Code>{`name: Local Assistant
models:
  - name: gpt-5.6-sol
    provider: openai
    model: gpt-5.6-sol
    apiBase: https://mapleai.shop/v1
    apiKey: oms_buy_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
    roles: [chat, edit, autocomplete]`}</Code>
        </Section>

        <Section id="hermes" title="4. Hermes / other agents (OpenAI-compatible)">
          Any tool with OpenAI-compatible endpoint support accepts the same three values:
          <Code>{`export OPENAI_BASE_URL="https://mapleai.shop/v1"
export OPENAI_API_KEY="oms_buy_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
export OPENAI_MODEL="gpt-5.6-sol"`}</Code>
        </Section>

        <Section id="verification" title="Verify the connection">
          Run in a terminal — expect HTTP 200:
          <Code>{`curl -X POST https://mapleai.shop/v1/responses \\
  -H "Authorization: Bearer oms_buy_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-5.6-sol",
    "stream": false,
    "input": [{"type":"message","role":"user","content":[{"type":"input_text","text":"say ok"}]}]
  }'`}</Code>
        </Section>

        <Section id="errors" title="Common errors">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border text-left text-text-muted">
                <th className="py-1.5 pr-2 font-medium">Error</th>
                <th className="py-1.5 pr-2 font-medium">Cause</th>
                <th className="py-1.5 font-medium">Action</th>
              </tr>
            </thead>
            <tbody className="[&>tr]:border-b [&>tr]:border-border/60">
              <tr>
                <td className="py-1.5 pr-2 font-mono">401 Invalid key</td>
                <td className="py-1.5 pr-2">Invalid or disabled key</td>
                <td className="py-1.5">Verify on the "Check key" page</td>
              </tr>
              <tr>
                <td className="py-1.5 pr-2 font-mono">402 Insufficient tokens</td>
                <td className="py-1.5 pr-2">Prepaid balance exhausted</td>
                <td className="py-1.5">Top up / renew the token pack</td>
              </tr>
              <tr>
                <td className="py-1.5 pr-2 font-mono">403 model not allowed</td>
                <td className="py-1.5 pr-2">Model not allowed for your key</td>
                <td className="py-1.5">Use only gpt-5.6-sol</td>
              </tr>
              <tr>
                <td className="py-1.5 pr-2 font-mono">long timeout &gt;10 min</td>
                <td className="py-1.5 pr-2">Very large context</td>
                <td className="py-1.5">Shrink the context and retry</td>
              </tr>
            </tbody>
          </table>
        </Section>
      </div>
    </PublicShell>
  );
}
