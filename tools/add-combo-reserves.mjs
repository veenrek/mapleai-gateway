// VDS-only: add verified reserve targets to prepaid combos so an agent never
// lands on "all credentials cooling down" after a paid request.
// Reads the gateway's current upstream key, registers it as a nexo connection
// scoped to the gpt-6-luna reserve, and appends reserve targets idempotently.
// Prints a summary without any credentials.
import Database from "better-sqlite3";
import { createCipheriv, randomBytes, scryptSync } from "node:crypto";
import fs from "node:fs";

const secret = fs
  .readFileSync("/var/lib/mapleai-admin/server.env", "utf8")
  .split("\n")
  .find((l) => l.startsWith("STORAGE_ENCRYPTION_KEY="))
  ?.split("=")[1]
  .trim();
if (!secret) throw new Error("STORAGE_ENCRYPTION_KEY missing");

const gatewayKey = fs
  .readFileSync("/opt/claude-api-sol/.env", "utf8")
  .split("\n")
  .find((l) => /^UPSTREAM_API_KEY=/.test(l))
  ?.split("=")[1]
  .trim();
if (!gatewayKey) throw new Error("gateway UPSTREAM_API_KEY missing");

const key = scryptSync(secret, "omniroute-field-encryption-v1", 32);
const encrypt = (plain) => {
  const iv = randomBytes(16);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const data = c.update(plain, "utf8", "hex") + c.final("hex");
  return `enc:v1:${iv.toString("hex")}:${data}:${c.getAuthTag().toString("hex")}`;
};

const NEXO_NODE = "openai-compatible-responses-73cc188d-cecb-46d8-93c0-b44dd0e55c1d";
const BYESU_NODE = "openai-compatible-responses-ccdecd52-e061-4522-93bd-8e2582d49825";
const NEXO_CONN_1 = "25c8a428-e06e-4c4b-bca1-164ba5703c92";
const BYESU_CONN = "c7ec58a9-0063-456f-805b-aa2cf80c3b4a";

const db = new Database("/var/lib/mapleai-admin/storage.sqlite");

// 1. Register the gateway's active upstream key as a dedicated nexo connection.
let gatewayConnId = db
  .prepare("SELECT id FROM provider_connections WHERE name = ? AND provider = ?")
  .get("gateway-main", NEXO_NODE)?.id;
if (!gatewayConnId) {
  const base = db
    .prepare("SELECT * FROM provider_connections WHERE id = ?")
    .get(NEXO_CONN_1);
  gatewayConnId = crypto.randomUUID();
  const now = new Date().toISOString();
  const columns = Object.keys(base).filter((c) => c !== "id");
  const values = {
    ...base,
    name: "gateway-main",
    display_name: "Gateway main upstream key (reserve)",
    api_key: encrypt(gatewayKey),
    is_active: 1,
    priority: 999,
    global_priority: 999,
    test_status: null,
    last_error: null,
    created_at: now,
    updated_at: now,
  };
  const placeholders = columns.map((c) => "@" + c).join(", ");
  db.prepare(
    `INSERT INTO provider_connections ("id", ${columns.map((c) => '"' + c + '"').join(", ")}) VALUES (@id, ${placeholders})`
  ).run({ ...values, id: gatewayConnId });
  console.log("inserted reserve connection gateway-main", gatewayConnId);
} else {
  db.prepare("UPDATE provider_connections SET api_key = ?, updated_at = ? WHERE id = ?").run(
    encrypt(gatewayKey),
    new Date().toISOString(),
    gatewayConnId
  );
  console.log("refreshed reserve connection gateway-main");
}

// 2. Append reserve targets per combo (verified 200 upstream before wiring).
const reserves = {
  "gpt-5.6-sol": [{ node: NEXO_NODE, connectionId: NEXO_CONN_1, model: "gpt-5.6-sol" }],
  "gpt-5.6-terra": [{ node: NEXO_NODE, connectionId: NEXO_CONN_1, model: "gpt-5.6-terra" }],
  "gpt-6-luna": [{ node: NEXO_NODE, connectionId: gatewayConnId, model: "gpt-6-luna" }],
  "gpt-6-sol": [{ node: NEXO_NODE, connectionId: NEXO_CONN_1, model: "gpt-6-sol" }],
  "gpt-6-astra": [
    { node: BYESU_NODE, connectionId: BYESU_CONN, model: "gpt-6-astra" },
    { node: NEXO_NODE, connectionId: NEXO_CONN_1, model: "gpt-6-astra" },
  ],
};

const getCombo = db.prepare("SELECT id, data FROM combos WHERE name = ?");
const updCombo = db.prepare("UPDATE combos SET data = ?, updated_at = ? WHERE id = ?");

for (const [comboName, adds] of Object.entries(reserves)) {
  const row = getCombo.get(comboName);
  if (!row) { console.log("combo missing:", comboName); continue; }
  const conf = JSON.parse(row.data);
  const models = Array.isArray(conf.models) ? conf.models : [];
  let changed = false;
  for (const add of adds) {
    const modelPath = `${add.node}/${add.model}`;
    if (models.some((m) => m.model === modelPath && m.connectionId === add.connectionId)) continue;
    models.push({
      id: `${comboName}-reserve-${add.model}-${add.connectionId.slice(0, 8)}`,
      kind: "model",
      model: modelPath,
      providerId: add.node,
      connectionId: add.connectionId,
      weight: 0,
    });
    changed = true;
  }
  if (changed) {
    updCombo.run(JSON.stringify(conf), new Date().toISOString(), row.id);
    console.log(`${comboName}: +${adds.length} reserve target(s), total ${models.length}`);
  } else {
    console.log(`${comboName}: reserves already present (${models.length})`);
  }
}

db.close();
console.log("done");
