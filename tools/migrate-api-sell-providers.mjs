import { randomBytes, scryptSync, createCipheriv } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const sourceRoot = process.env.API_SELL_SOURCE ?? "D:/dev/api_sell";
const sourceDataDir = join(process.env.APPDATA ?? "", "OmniRoute");
const sourceDbPath = join(sourceDataDir, "storage.sqlite");
const sourceEnvPath = join(sourceDataDir, "server.env");
const identity = join(process.env.USERPROFILE ?? "", ".ssh", "hermes_vds_transfer");
const host = process.env.MAPLEAI_VDS ?? "root@31.77.207.76";
const apply = process.argv.includes("--apply");
const combosOnly = process.argv.includes("--combos-only");
const settingsOnly = process.argv.includes("--settings-only");

function parseEnv(path) {
  const values = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line || line.trimStart().startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    values[line.slice(0, separator).trim()] = line.slice(separator + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return values;
}

const sourceEnv = parseEnv(sourceEnvPath);
if (!sourceEnv.STORAGE_ENCRYPTION_KEY) throw new Error("Source STORAGE_ENCRYPTION_KEY is missing");
process.env.STORAGE_ENCRYPTION_KEY = sourceEnv.STORAGE_ENCRYPTION_KEY;

const sourceRequire = createRequire(join(sourceRoot, "package.json"));
const Database = sourceRequire("better-sqlite3");
const db = new Database(sourceDbPath, { readonly: true, fileMustExist: true });
const sourceConnections = db.prepare("SELECT * FROM provider_connections ORDER BY id").all();
const sourceNodes = db.prepare("SELECT * FROM provider_nodes ORDER BY id").all();
const sourceCombos = db.prepare("SELECT * FROM combos ORDER BY sort_order, name").all();
const sourceProviderSettings = db.prepare(
  "SELECT namespace, key, value FROM key_value WHERE namespace = 'settings' AND key IN ('enabledProviders', 'blockedProviders') ORDER BY key"
).all();
db.close();

const { decrypt, migrateLegacyEncryptedString } = await import(
  pathToFileURL(join(sourceRoot, "src/lib/db/encryption.ts")).href
);
const credentialFields = [
  ["api_key", "apiKey"],
  ["access_token", "accessToken"],
  ["refresh_token", "refreshToken"],
  ["id_token", "idToken"],
];
let encryptedCredentialCells = 0;
for (const row of sourceConnections) {
  for (const [column] of credentialFields) {
    const value = row[column];
    if (typeof value !== "string" || !value.startsWith("enc:v1:")) continue;
    encryptedCredentialCells += 1;
    const migrated = migrateLegacyEncryptedString(value);
    const plain = decrypt(migrated.value);
    if (typeof plain !== "string") throw new Error("Could not decrypt every source provider credential");
    row[column] = plain;
  }
}

const providers = sourceNodes.map((node) => ({ id: node.id, name: node.name }));
console.log(JSON.stringify({
  mode: apply ? (settingsOnly ? "settings-only" : combosOnly ? "combos-only" : "apply") : "dry-run",
  providerConnections: combosOnly || settingsOnly ? 0 : sourceConnections.length,
  routingCombos: settingsOnly ? 0 : sourceCombos.length,
  providerVisibilitySettings: sourceProviderSettings.map((setting) => ({ key: setting.key, value: JSON.parse(setting.value) })),
  customProviders: providers,
  encryptedCredentialCells,
  allEncryptedCredentialsReadable: true,
}));

if (!apply) {
  console.log("Dry run only. Use --apply for a fresh destination, --combos-only --apply for combos, or --settings-only --apply for provider visibility settings.");
  process.exit(0);
}

const payload = JSON.stringify({
  mode: settingsOnly ? "settings-only" : combosOnly ? "combos-only" : "providers-combos-and-settings",
  connections: combosOnly || settingsOnly ? [] : sourceConnections,
  nodes: combosOnly || settingsOnly ? [] : sourceNodes,
  combos: settingsOnly ? [] : sourceCombos,
  providerSettings: sourceProviderSettings,
});
const remoteScript = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const Database = require('/opt/mapleai-admin/node_modules/better-sqlite3');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const comboOnly = input.mode === 'combos-only';
const settingsOnly = input.mode === 'settings-only';
const dataDir = '/var/lib/mapleai-admin';
const dbPath = path.join(dataDir, 'storage.sqlite');
const serverEnv = fs.readFileSync(path.join(dataDir, 'server.env'), 'utf8');
const keyLine = serverEnv.split(/\r?\n/).find(line => line.startsWith('STORAGE_ENCRYPTION_KEY='));
const encryptionSecret = keyLine?.slice(keyLine.indexOf('=') + 1).trim().replace(/^(["'])(.*)\1$/, '$2');
if (!encryptionSecret) throw new Error('VDS STORAGE_ENCRYPTION_KEY is missing');
const encryptionKey = crypto.scryptSync(encryptionSecret, 'omniroute-field-encryption-v1', 32);
function encrypt(value) {
  if (typeof value !== 'string' || value.length === 0) return value;
  if (value.startsWith('enc:v1:')) throw new Error('Source credential was not decrypted before transfer');
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]).toString('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return 'enc:v1:' + iv.toString('hex') + ':' + ciphertext + ':' + tag;
}
const stopped = spawnSync('systemctl', ['stop', 'mapleai-admin.service'], { encoding: 'utf8' });
if (stopped.status !== 0) throw new Error('Could not stop MapleAI admin before import');
let backupPath;
let db;
try {
  fs.mkdirSync(path.join(dataDir, 'db_backups'), { recursive: true, mode: 0o700 });
  backupPath = path.join(dataDir, 'db_backups', 'before-provider-combo-import-' + new Date().toISOString().replace(/[:.]/g, '-') + '.sqlite');
  db = new Database(dbPath);
  const existingConnections = db.prepare('SELECT COUNT(*) AS count FROM provider_connections').get().count;
  const existingNodes = db.prepare('SELECT COUNT(*) AS count FROM provider_nodes').get().count;
  const existingCombos = db.prepare('SELECT COUNT(*) AS count FROM combos').get().count;
  if (comboOnly) {
    if (existingConnections === 0 || existingNodes === 0) throw new Error('Providers must be imported before combo-only migration');
  } else if (settingsOnly) {
    if (existingConnections === 0 || existingNodes === 0) throw new Error('Providers must be imported before provider settings migration');
  } else if (existingConnections !== 0 || existingNodes !== 0) {
    throw new Error('Destination already contains provider records; refusing to merge automatically');
  }
  if (!settingsOnly && existingCombos !== 0) throw new Error('Destination already contains routing combos; refusing to merge automatically');
  await db.backup(backupPath);
  fs.chmodSync(backupPath, 0o600);
  const nodeColumns = new Set(db.prepare('PRAGMA table_info(provider_nodes)').all().map(row => row.name));
  const connectionColumns = new Set(db.prepare('PRAGMA table_info(provider_connections)').all().map(row => row.name));
  const comboColumns = new Set(db.prepare('PRAGMA table_info(combos)').all().map(row => row.name));
  const nodeFields = Object.keys(input.nodes[0] ?? {}).filter(key => nodeColumns.has(key));
  const connectionFields = Object.keys(input.connections[0] ?? {}).filter(key => connectionColumns.has(key));
  const comboFields = Object.keys(input.combos[0] ?? {}).filter(key => comboColumns.has(key));
  for (const required of ['id', 'type', 'name', 'base_url']) if (!nodeColumns.has(required)) throw new Error('Destination provider_nodes schema mismatch');
  for (const required of ['id', 'provider', 'auth_type', 'is_active']) if (!connectionColumns.has(required)) throw new Error('Destination provider_connections schema mismatch');
  for (const required of ['id', 'name', 'data']) if (!comboColumns.has(required)) throw new Error('Destination combos schema mismatch');
  const nodeInsert = nodeFields.length ? db.prepare('INSERT INTO provider_nodes (' + nodeFields.map(key => '"' + key + '"').join(',') + ') VALUES (' + nodeFields.map(() => '?').join(',') + ')') : null;
  const connectionInsert = connectionFields.length ? db.prepare('INSERT INTO provider_connections (' + connectionFields.map(key => '"' + key + '"').join(',') + ') VALUES (' + connectionFields.map(() => '?').join(',') + ')') : null;
  const comboInsert = comboFields.length ? db.prepare('INSERT INTO combos (' + comboFields.map(key => '"' + key + '"').join(',') + ') VALUES (' + comboFields.map(() => '?').join(',') + ')') : null;
  const settingInsert = db.prepare("INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES (?, ?, ?)");
  const importRows = db.transaction(() => {
    for (const row of input.nodes) nodeInsert.run(...nodeFields.map(key => row[key] ?? null));
    for (const row of input.connections) {
      for (const field of ['api_key', 'access_token', 'refresh_token', 'id_token']) row[field] = encrypt(row[field]);
      connectionInsert.run(...connectionFields.map(key => row[key] ?? null));
    }
    for (const row of input.combos) comboInsert.run(...comboFields.map(key => row[key] ?? null));
    for (const row of input.providerSettings) settingInsert.run(row.namespace, row.key, row.value);
  });
  importRows();
  db.close();
  db = undefined;
  fs.chmodSync(path.join(dataDir, 'server.env'), 0o600);
  fs.chmodSync(dbPath, 0o600);
  for (const suffix of ['-wal', '-shm']) {
    const file = dbPath + suffix;
    if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
  }
  fs.chmodSync(dataDir, 0o700);
  console.log(JSON.stringify({ importedProviderConnections: input.connections.length, importedCustomProviders: input.nodes.length, importedRoutingCombos: input.combos.length, importedProviderSettings: input.providerSettings.length, encryptedCredentialCells: input.connections.reduce((n, row) => n + ['api_key','access_token','refresh_token','id_token'].filter(key => typeof row[key] === 'string' && row[key].startsWith('enc:v1:')).length, 0), backupCreated: true }));
} finally {
  if (db) db.close();
  const started = spawnSync('systemctl', ['start', 'mapleai-admin.service'], { encoding: 'utf8' });
  if (started.status !== 0) throw new Error('Provider import finished, but MapleAI admin did not restart');
}
const verify = new Database(dbPath, { readonly: true });
const counts = {
  providerConnections: verify.prepare('SELECT COUNT(*) AS count FROM provider_connections').get().count,
  customProviders: verify.prepare('SELECT COUNT(*) AS count FROM provider_nodes').get().count,
  routingCombos: verify.prepare('SELECT COUNT(*) AS count FROM combos').get().count,
  enabledProviders: verify.prepare("SELECT value FROM key_value WHERE namespace = 'settings' AND key = 'enabledProviders'").get()?.value ?? null,
  activeConnections: verify.prepare('SELECT COUNT(*) AS count FROM provider_connections WHERE is_active = 1').get().count,
};
verify.close();
console.log(JSON.stringify({ verified: counts }));
`;
const remoteProgram = `(async () => {\n${remoteScript}\n})().catch(error => { console.error(error?.stack ?? String(error)); process.exitCode = 1; });`;
const encodedScript = Buffer.from(remoteProgram, "utf8").toString("base64");
const sshPath = process.env.WINDIR
  ? join(process.env.WINDIR, "System32", "OpenSSH", "ssh.exe")
  : "ssh";
const remoteCommand = `/opt/node22/bin/node -e 'eval(Buffer.from("${encodedScript}","base64").toString())'`;
const ssh = spawn(sshPath, [
  "-o", "BatchMode=yes",
  "-o", "StrictHostKeyChecking=yes",
  "-o", "ConnectTimeout=10",
  "-o", "IdentitiesOnly=yes",
  "-i", identity,
  host,
  remoteCommand,
], { stdio: ["pipe", "pipe", "pipe"] });

let stdout = "";
let stderr = "";
ssh.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
ssh.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
const exitCode = await new Promise((resolve, reject) => {
  ssh.once("error", reject);
  ssh.once("close", resolve);
  ssh.stdin.end(payload);
});
if (exitCode !== 0) throw new Error("Provider import failed: " + stderr.trim());
process.stdout.write(stdout);
