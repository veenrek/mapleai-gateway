// VDS-only probe: which models does each prepaid provider actually serve?
// Reads encrypted keys from the admin database, decrypts them in memory only,
// and prints HTTP statuses — never the credentials.
import Database from "better-sqlite3";
import { createDecipheriv, createHash, scryptSync } from "node:crypto";
import fs from "node:fs";

const env = fs.readFileSync("/var/lib/mapleai-admin/server.env", "utf8");
const secret = env.split("\n").map((l) => {
  const i = l.indexOf("=");
  return l.startsWith("STORAGE_ENCRYPTION_KEY=") ? l.slice(i + 1).trim().replace(/^"|"$/g, "") : null;
}).find(Boolean);
if (!secret) throw new Error("STORAGE_ENCRYPTION_KEY missing");

const staticKey = scryptSync(secret, "omniroute-field-encryption-v1", 32);
const legacyKey = scryptSync(secret, createHash("sha256").update(secret).digest().slice(0, 16), 32);
const tryDec = (key, ivHex, dataHex, tagHex) => {
  try {
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"), { authTagLength: 16 });
    d.setAuthTag(Buffer.from(tagHex, "hex"));
    return d.update(dataHex, "hex", "utf8") + d.final("utf8");
  } catch { return null; }
};
const decrypt = (value) => {
  if (!value || !value.startsWith("enc:v1:")) return value;
  const [ivHex, dataHex, tagHex] = value.slice(7).split(":");
  return tryDec(staticKey, ivHex, dataHex, tagHex) ?? tryDec(legacyKey, ivHex, dataHex, tagHex);
};

const db = new Database("/var/lib/mapleai-admin/storage.sqlite", { readonly: true });
const keyFor = (id) =>
  decrypt(db.prepare("SELECT api_key FROM provider_connections WHERE id = ?").get(id)?.api_key);

const MODELS = ["gpt-6-luna"];
const targets = [
  { label: "gw-main-resp", key: keyFor("011aff54-f092-4d47-8197-7b4a7a39b2be"), protocol: "responses" },
  { label: "gw-main-chat", key: keyFor("011aff54-f092-4d47-8197-7b4a7a39b2be"), protocol: "chat" },
];
const baseUrls = {
  "gw-main-resp": "https://www.nexotoken.net/v1",
  "gw-main-chat": "https://www.nexotoken.net/v1",
};

for (const t of targets) {
  if (!t.key) { console.log(`${t.label}: no key`); continue; }
  for (const model of MODELS) {
    const path = t.protocol === "chat" ? "/chat/completions" : "/responses";
    const body = t.protocol === "chat"
      ? { model, messages: [{ role: "user", content: "hi" }], max_tokens: 1 }
      : { model, input: "hi", max_output_tokens: 16 };
    try {
      const res = await fetch(baseUrls[t.label] + path, {
        method: "POST",
        headers: { authorization: `Bearer ${t.key}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      const text = (await res.text()).replace(/sk-[A-Za-z0-9_-]+/g, "[key]").slice(0, 100);
      console.log(`${t.label} ${model}: HTTP ${res.status}${res.ok ? "" : " " + text}`);
    } catch (e) {
      console.log(`${t.label} ${model}: FETCH FAIL ${e?.name}`);
    }
  }
}
db.close();
