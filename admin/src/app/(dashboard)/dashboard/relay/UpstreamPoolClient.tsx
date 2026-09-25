"use client";

import { useState, useEffect, useCallback } from "react";
import Card from "@/shared/components/Card";
import Badge from "@/shared/components/Badge";
import Button from "@/shared/components/Button";
import { useNotificationStore } from "@/store/notificationStore";

interface RelayAccount {
  id: string;
  name: string;
  providerType: "anthropic" | "openai" | "codex";
  baseUrl: string | null;
  authHeader: string;
  model: string | null;
  modelsCache: string[] | null;
  proxyUrl: string | null;
  enabled: boolean;
  active: boolean;
  maxMessages: number;
  maxTokens: number;
  cooldownUntil: string | null;
  disabledUntil: string | null;
  lastError: string | null;
  lastStatus: number | null;
  successCount: number;
  errorCount: number;
  tokensIn: number;
  tokensOut: number;
  hasApiKey: boolean;
  hasCodexRefreshToken: boolean;
  apiKeyPrefix: string | null;
}

interface PoolStats {
  total: number;
  enabled: number;
  byProviderType: Array<{ providerType: string; count: number }>;
  totalSuccess: number;
  totalErrors: number;
  totalTokensIn: number;
  totalTokensOut: number;
}

interface TestResult {
  ok: boolean;
  status?: number;
  latencyMs?: number;
  error?: string;
  responsePreview?: string;
}

const EMPTY_FORM = {
  name: "",
  providerType: "anthropic" as RelayAccount["providerType"],
  baseUrl: "",
  apiKey: "",
  authHeader: "x-api-key",
  model: "",
  proxyUrl: "",
};

const PROVIDER_BADGE: Record<RelayAccount["providerType"], string> = {
  anthropic: "success",
  openai: "info",
  codex: "warning",
};

function isBlocked(account: RelayAccount): boolean {
  if (!account.enabled) return true;
  if (account.cooldownUntil && Date.parse(account.cooldownUntil) > Date.now()) return true;
  if (account.disabledUntil && Date.parse(account.disabledUntil) > Date.now()) return true;
  return false;
}

export default function UpstreamPoolClient() {
  const [accounts, setAccounts] = useState<RelayAccount[]>([]);
  const [stats, setStats] = useState<PoolStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState("");
  const [form, setForm] = useState(EMPTY_FORM);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({});
  const addNotification = useNotificationStore((s) => s.addNotification);

  const fetchAccounts = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/relay/accounts");
      const data = await res.json();
      setAccounts(Array.isArray(data.accounts) ? data.accounts : []);
      setStats(data.stats ?? null);
    } catch {
      addNotification({ type: "error", message: "Failed to load relay accounts" });
    } finally {
      setLoading(false);
    }
  }, [addNotification]);

  useEffect(() => {
    fetchAccounts();
  }, [fetchAccounts]);

  const createAccount = async () => {
    if (!form.name.trim()) return;
    try {
      const res = await fetch("/api/relay/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          providerType: form.providerType,
          baseUrl: form.baseUrl || undefined,
          apiKey: form.apiKey || undefined,
          authHeader: form.authHeader,
          model: form.model || undefined,
          proxyUrl: form.proxyUrl || undefined,
        }),
      });
      if (res.ok) {
        addNotification({ type: "success", message: "Upstream account added" });
        setForm(EMPTY_FORM);
        setShowCreate(false);
        fetchAccounts();
      } else {
        const data = await res.json().catch(() => ({}));
        addNotification({ type: "error", message: data.error || "Failed to add account" });
      }
    } catch {
      addNotification({ type: "error", message: "Failed to add account" });
    }
  };

  const importAccounts = async () => {
    try {
      const parsed = JSON.parse(importText);
      const res = await fetch("/api/relay/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed),
      });
      const data = await res.json();
      if (res.ok && typeof data.imported === "number") {
        addNotification({
          type: "success",
          message: `Imported ${data.imported} account(s), skipped ${data.skipped}`,
        });
        setImportText("");
        setShowImport(false);
        fetchAccounts();
      } else {
        addNotification({ type: "error", message: data.error || "Import failed" });
      }
    } catch {
      addNotification({ type: "error", message: "Invalid JSON" });
    }
  };

  const patchAccount = async (id: string, patch: Record<string, unknown>) => {
    try {
      await fetch(`/api/relay/accounts/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      fetchAccounts();
    } catch {
      addNotification({ type: "error", message: "Update failed" });
    }
  };

  const deleteAccount = async (id: string) => {
    if (!confirm("Delete this upstream account? This cannot be undone.")) return;
    try {
      await fetch(`/api/relay/accounts/${id}`, { method: "DELETE" });
      addNotification({ type: "success", message: "Account deleted" });
      fetchAccounts();
    } catch {
      addNotification({ type: "error", message: "Failed to delete account" });
    }
  };

  const testAccount = async (id: string) => {
    setTesting(id);
    try {
      const res = await fetch(`/api/relay/accounts/${id}/test`, { method: "POST" });
      const result = (await res.json()) as TestResult;
      setTestResults((prev) => ({ ...prev, [id]: result }));
      fetchAccounts();
    } catch {
      addNotification({ type: "error", message: "Test request failed" });
    } finally {
      setTesting(null);
    }
  };

  const fmtTokens = (n: number) =>
    n >= 1_000_000
      ? `${(n / 1_000_000).toFixed(1)}M`
      : n >= 1000
        ? `${(n / 1000).toFixed(1)}k`
        : String(n);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold">Upstream Pool</h2>
          <p className="text-sm text-text-muted mt-1">
            Rotation pool of upstream accounts (anthropic / openai / codex). The{" "}
            <code className="font-mono text-xs">relay-pool</code> provider rotates through them per
            request — route via combos or{" "}
            <code className="font-mono text-xs">relay-pool/&lt;model&gt;</code>.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => setShowImport(!showImport)}>
            Import accounts.json
          </Button>
          <Button onClick={() => setShowCreate(!showCreate)}>
            {showCreate ? "Cancel" : "Add Account"}
          </Button>
        </div>
      </div>

      {/* Stats */}
      {stats && stats.total > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card>
            <div className="p-3 text-center">
              <div className="text-2xl font-bold">
                {stats.enabled}/{stats.total}
              </div>
              <div className="text-xs text-text-muted">enabled accounts</div>
            </div>
          </Card>
          <Card>
            <div className="p-3 text-center">
              <div className="text-2xl font-bold">{stats.totalSuccess}</div>
              <div className="text-xs text-text-muted">successful requests</div>
            </div>
          </Card>
          <Card>
            <div className="p-3 text-center">
              <div className="text-2xl font-bold">{stats.totalErrors}</div>
              <div className="text-xs text-text-muted">errors</div>
            </div>
          </Card>
          <Card>
            <div className="p-3 text-center">
              <div className="text-2xl font-bold">
                {fmtTokens(stats.totalTokensIn)}/{fmtTokens(stats.totalTokensOut)}
              </div>
              <div className="text-xs text-text-muted">tokens in/out</div>
            </div>
          </Card>
        </div>
      )}

      {/* Create Form */}
      {showCreate && (
        <Card>
          <div className="p-4 space-y-4">
            <h3 className="text-sm font-semibold">Add Upstream Account</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1">Name *</label>
                <input
                  className="w-full border border-border rounded-lg px-3 py-2 bg-surface text-sm"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="nvidia-main"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Provider Type *</label>
                <select
                  className="w-full border border-border rounded-lg px-3 py-2 bg-surface text-sm"
                  value={form.providerType}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      providerType: e.target.value as RelayAccount["providerType"],
                    })
                  }
                >
                  <option value="anthropic">anthropic (passthrough)</option>
                  <option value="openai">openai-compatible (converted)</option>
                  <option value="codex">codex — chatgpt.com backend (TLS fingerprint)</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Base URL</label>
                <input
                  className="w-full border border-border rounded-lg px-3 py-2 bg-surface text-sm"
                  value={form.baseUrl}
                  onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
                  placeholder="https://integrate.api.nvidia.com/v1"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">API Key</label>
                <input
                  type="password"
                  className="w-full border border-border rounded-lg px-3 py-2 bg-surface text-sm"
                  value={form.apiKey}
                  onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                  placeholder={form.providerType === "codex" ? "JWT access token" : "sk-..."}
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Auth Header</label>
                <select
                  className="w-full border border-border rounded-lg px-3 py-2 bg-surface text-sm"
                  value={form.authHeader}
                  onChange={(e) => setForm({ ...form, authHeader: e.target.value })}
                >
                  <option value="x-api-key">x-api-key</option>
                  <option value="authorization">authorization (Bearer)</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Model</label>
                <input
                  className="w-full border border-border rounded-lg px-3 py-2 bg-surface text-sm"
                  value={form.model}
                  onChange={(e) => setForm({ ...form, model: e.target.value })}
                  placeholder="grok-4.6-high (round-robin group key)"
                />
              </div>
              <div className="md:col-span-2">
                <label className="block text-sm font-medium mb-1">Proxy URL (optional)</label>
                <input
                  className="w-full border border-border rounded-lg px-3 py-2 bg-surface text-sm"
                  value={form.proxyUrl}
                  onChange={(e) => setForm({ ...form, proxyUrl: e.target.value })}
                  placeholder="http://user:pass@host:port or socks5://host:port"
                />
              </div>
            </div>
            <Button onClick={createAccount} disabled={!form.name.trim()}>
              Add Account
            </Button>
          </div>
        </Card>
      )}

      {/* Import */}
      {showImport && (
        <Card>
          <div className="p-4 space-y-3">
            <h3 className="text-sm font-semibold">Import from anthropic-api-relay export</h3>
            <p className="text-xs text-text-muted">
              Paste the contents of an <code className="font-mono">accounts.json</code> file (raw
              array or {"{ accounts: [...] }"} wrapper). Duplicates are skipped.
            </p>
            <textarea
              className="w-full h-40 border border-border rounded-lg px-3 py-2 bg-surface text-xs font-mono"
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              placeholder='{"accounts": [...]}'
            />
            <Button onClick={importAccounts} disabled={!importText.trim()}>
              Import
            </Button>
          </div>
        </Card>
      )}

      {/* Accounts List */}
      <Card>
        <div className="p-4">
          <h3 className="text-sm font-semibold mb-3">Accounts ({accounts.length})</h3>
          {loading ? (
            <p className="text-sm text-text-muted">Loading...</p>
          ) : accounts.length === 0 ? (
            <p className="text-sm text-text-muted">
              No upstream accounts. Add one or import an existing anthropic-api-relay accounts.json.
            </p>
          ) : (
            <div className="space-y-2">
              {accounts.map((a) => {
                const blocked = isBlocked(a);
                const testResult = testResults[a.id];
                return (
                  <div key={a.id} className="border border-border rounded-lg p-3 space-y-2">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-start gap-3 min-w-0">
                        <div
                          className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${
                            blocked ? "bg-red-500" : a.active ? "bg-blue-500" : "bg-green-500"
                          }`}
                          title={
                            blocked
                              ? `blocked${a.cooldownUntil ? ` until ${a.cooldownUntil}` : ""}`
                              : a.active
                                ? "sticky account"
                                : "healthy"
                          }
                        />
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium text-sm">{a.name}</span>
                            <Badge
                              variant={
                                PROVIDER_BADGE[a.providerType] as "success" | "info" | "warning"
                              }
                              size="sm"
                            >
                              {a.providerType}
                            </Badge>
                            {a.model && (
                              <Badge variant="default" size="sm">
                                {a.model}
                              </Badge>
                            )}
                          </div>
                          <div className="text-xs text-text-muted font-mono truncate mt-0.5">
                            {a.baseUrl || "default base url"} · {a.apiKeyPrefix ?? "no key"}…
                          </div>
                          {a.lastError && (
                            <div className="text-xs text-red-500 mt-1 truncate" title={a.lastError}>
                              HTTP {a.lastStatus}: {a.lastError.slice(0, 120)}
                            </div>
                          )}
                          {(testResult?.ok === false || testResult?.error) && (
                            <div className="text-xs text-red-500 mt-1">
                              test failed: {testResult.error || `HTTP ${testResult.status}`}
                            </div>
                          )}
                          {testResult?.ok && (
                            <div className="text-xs text-green-600 dark:text-green-400 mt-1">
                              test ok · HTTP {testResult.status} · {testResult.latencyMs}ms
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
                        <Badge variant="default" size="sm">
                          ✓ {a.successCount}
                        </Badge>
                        <Badge variant="default" size="sm">
                          ✗ {a.errorCount}
                        </Badge>
                        <Badge variant="default" size="sm">
                          {fmtTokens(a.tokensIn)}/{fmtTokens(a.tokensOut)}
                        </Badge>
                        <button
                          onClick={() => testAccount(a.id)}
                          disabled={testing === a.id}
                          className="text-xs text-primary hover:underline disabled:opacity-50"
                        >
                          {testing === a.id ? "…" : "Test"}
                        </button>
                        {blocked && (
                          <button
                            onClick={() =>
                              patchAccount(a.id, { clearCooldown: true, enabled: true })
                            }
                            className="text-xs text-yellow-600 hover:underline"
                          >
                            Unblock
                          </button>
                        )}
                        <button
                          onClick={() => patchAccount(a.id, { enabled: !a.enabled })}
                          className="text-xs text-primary hover:underline"
                        >
                          {a.enabled ? "Disable" : "Enable"}
                        </button>
                        <button
                          onClick={() => deleteAccount(a.id)}
                          className="text-xs text-red-500 hover:underline"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
