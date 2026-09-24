import { readFileSync } from 'node:fs';

if (process.argv.length < 3) {
  process.stderr.write('Usage: node tools/payment-report.mjs <payment-events.jsonl> [...]' + String.fromCharCode(10));
  process.exit(1);
}

const summary = new Map();
const seen = new Set();
for (const file of process.argv.slice(2)) {
  let contents;
  try { contents = readFileSync(file, 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') continue;
    throw error;
  }
  for (const line of contents.split(String.fromCharCode(10))) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (!event.network || !event.kind) continue;
    const key = event.network;
    const stats = summary.get(key) ?? { settled: 0, amountAtomic: 0n, challenges: 0, rejected: 0, failed: 0, unconfirmed: 0, payers: new Set(), reasons: {} };
    if (event.kind === 'settled' && /^[0-9]+$/.test(event.amountAtomic ?? '') && event.transaction) {
      const transactionKey = key + ':' + event.transaction;
      if (seen.has(transactionKey)) continue;
      seen.add(transactionKey);
      stats.settled += 1;
      stats.amountAtomic += BigInt(event.amountAtomic);
      if (event.payer) stats.payers.add(event.payer);
    } else if (event.kind === 'payment_challenge') stats.challenges += 1;
    else if (event.kind === 'payment_rejected') stats.rejected += 1;
    else if (event.kind === 'request_failed') stats.failed += 1;
    else if (event.kind === 'settlement_unconfirmed') stats.unconfirmed += 1;
    if (event.kind !== 'settled' && event.reason) {
      const reason = event.kind + ':' + event.reason;
      stats.reasons[reason] = (stats.reasons[reason] ?? 0) + 1;
    }
    summary.set(key, stats);
  }
}

for (const [network, stats] of summary) {
  const amount = stats.amountAtomic.toString().padStart(7, '0');
  process.stdout.write(JSON.stringify({ network, settled: stats.settled,
    receivedUsdc: amount.slice(0, -6) + '.' + amount.slice(-6),
    uniquePayers: stats.payers.size, challenges: stats.challenges, rejected: stats.rejected,
    requestFailed: stats.failed, settlementUnconfirmed: stats.unconfirmed, reasons: stats.reasons }) + String.fromCharCode(10));
}
