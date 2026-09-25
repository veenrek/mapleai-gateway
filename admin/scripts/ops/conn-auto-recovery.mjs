/**
 * Auto-recovery для apikey-коннекшенов: каждые 3 мин снимает зомби-флаги
 * `credits_exhausted` / `rate_limited`, которые появляются после разового
 * 402/429 от апстрима. С временем, когда на ключе снова есть деньги,
 * подключение вернётся в строй автоматически без ручного вмешательства.
 */
import Database from "better-sqlite3";
import path from "node:path";

const DB_PATH = path.join(process.env.APPDATA ?? "", "omniroute", "storage.sqlite");
const INTERVAL_MS = 180_000; // 3 минуты
const CONNECTION_IDS = [
  "06f1e091-af5c-4aa0-93af-b7418c4f8b21", // nexo1
  "c7ec58a9-0063-456f-805b-aa2cf80c3b4a", // byesu1
];

const db = new Database(DB_PATH);

function sweep() {
  try {
    const placeholders = CONNECTION_IDS.map(() => "?").join(",");
    const stale = db.prepare(
      `SELECT id, name, test_status, error_code, last_error_at FROM provider_connections WHERE is_active = 1 AND (test_status IS NOT NULL OR rate_limited_until IS NOT NULL) AND id IN (${placeholders})`
    ).all(...CONNECTION_IDS);

    for (const c of stale) {
      const lastAt = c.last_error_at ? new Date(c.last_error_at).getTime() : 0;
      // не трогаем свежие ошибки (< 3 мин) — избегаем троят спотыкание падающего ключа
      if (lastAt && Date.now() - lastAt < 120_000) continue;
      db.prepare(
        `UPDATE provider_connections SET test_status='active', error_code=null, last_error=null, rate_limited_until=null WHERE id = ?`
      ).run(c.id);
      console.log(`[conn-recovery] ${c.name}/${c.id}: cleared status ${c.test_status}/${c.error_code}`);
    }
  } catch (e) {
    console.error("[conn-recovery] sweep error:", e?.message ?? e);
  }
}

sweep();
setInterval(sweep, INTERVAL_MS);
console.log(`[conn-recovery] watching ${CONNECTION_IDS.length} connections every ${INTERVAL_MS / 1000}s`);
