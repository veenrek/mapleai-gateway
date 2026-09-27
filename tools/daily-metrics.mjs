#!/usr/bin/env node
/**
 * Daily MapleAI metrics: revenue by network/route, unique/new/returning
 * payers, payment funnel and free-embeddings usage.
 *
 * Reads the gateway event journals (payment-events.jsonl and
 * embedding-events.jsonl) from one or more gateway directories and writes a
 * JSON report for a UTC day (default: yesterday).
 *
 * Usage:
 *   node tools/daily-metrics.mjs [--date YYYY-MM-DD] [--today] \
 *     [--gateways /opt/claude-api-sol,/opt/claude-api-base,...] \
 *     [--out /opt/metrics/reports]
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf('--' + name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const gateways = option('gateways', '/opt/claude-api-sol,/opt/claude-api-base,/opt/claude-api-polygon,/opt/claude-api-arc')
  .split(',').map((p) => p.trim()).filter(Boolean);
const outDir = option('out', '/opt/metrics/reports');

function utcDay(offsetDays = 0) {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offsetDays))
    .toISOString().slice(0, 10);
}
const date = option('date', args.includes('--today') ? utcDay(0) : utcDay(-1));
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error('Invalid --date, expected YYYY-MM-DD');
  process.exit(1);
}

function* lines(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    yield event;
  }
}

const usdc = (atomic) => {
  const value = BigInt(atomic);
  return (value / 1_000_000n).toString() + '.' + (value % 1_000_000n).toString().padStart(6, '0');
};
const add = (a, b) => (a ?? 0n) + b;

const report = {
  date,
  generatedAt: new Date().toISOString(),
  revenue: { totalAtomic: '0', byNetwork: {}, byRoute: {} },
  payers: { unique: 0, new: 0, returning: 0, allTime: 0 },
  funnel: { challenges: 0, rejected: 0, settled: 0, unconfirmed: 0, failed: 0 },
  embeddings: { requests: 0, success: 0, errors: 0, byDomain: {} },
};

const seenTransactions = new Set();
const payersToday = new Set();
const payersBefore = new Set();
const allPayers = new Set();
let totalAtomic = 0n;

for (const dir of gateways) {
  for (const event of lines(join(dir, 'payment-events.jsonl'))) {
    if (typeof event.ts !== 'string' || !event.kind) continue;
    const day = event.ts.slice(0, 10);
    if (event.kind === 'settled' && event.transaction && /^[0-9]+$/.test(event.amountAtomic ?? '')) {
      const txKey = event.network + ':' + event.transaction;
      if (seenTransactions.has(txKey)) continue;
      seenTransactions.add(txKey);
      if (event.payer) {
        allPayers.add(event.payer);
        if (day < date) payersBefore.add(event.payer);
      }
      if (day !== date) continue;
      totalAtomic = add(totalAtomic, BigInt(event.amountAtomic));
      const net = report.revenue.byNetwork[event.network] ??= { usdcAtomic: '0', settled: 0 };
      net.usdcAtomic = add(BigInt(net.usdcAtomic), BigInt(event.amountAtomic)).toString();
      net.settled += 1;
      const route = report.revenue.byRoute[event.route] ??= { usdcAtomic: '0', settled: 0 };
      route.usdcAtomic = add(BigInt(route.usdcAtomic), BigInt(event.amountAtomic)).toString();
      route.settled += 1;
      if (event.payer) payersToday.add(event.payer);
      report.funnel.settled += 1;
      continue;
    }
    if (day !== date) continue;
    if (event.kind === 'payment_challenge') report.funnel.challenges += 1;
    else if (event.kind === 'payment_rejected') report.funnel.rejected += 1;
    else if (event.kind === 'settlement_unconfirmed') report.funnel.unconfirmed += 1;
    else if (event.kind === 'request_failed') report.funnel.failed += 1;
  }

  for (const event of lines(join(dir, 'embedding-events.jsonl'))) {
    if (typeof event.ts !== 'string' || event.ts.slice(0, 10) !== date) continue;
    const domain = event.domain ?? 'unknown';
    const stats = report.embeddings.byDomain[domain] ??= { requests: 0, success: 0, errors: 0 };
    stats.requests += 1;
    report.embeddings.requests += 1;
    if (event.status === 200) { stats.success += 1; report.embeddings.success += 1; }
    else { stats.errors += 1; report.embeddings.errors += 1; }
  }
}

report.revenue.totalAtomic = totalAtomic.toString();
report.revenue.totalUsdc = usdc(totalAtomic);
for (const group of [report.revenue.byNetwork, report.revenue.byRoute]) {
  for (const entry of Object.values(group)) {
    entry.usdc = usdc(entry.usdcAtomic);
    delete entry.usdcAtomic;
  }
}
report.payers.unique = payersToday.size;
report.payers.new = [...payersToday].filter((p) => !payersBefore.has(p)).length;
report.payers.returning = report.payers.unique - report.payers.new;
report.payers.allTime = allPayers.size;

mkdirSync(outDir, { recursive: true });
const file = join(outDir, date + '.json');
writeFileSync(file, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });

const topRoutes = Object.entries(report.revenue.byRoute)
  .sort((a, b) => b[1].settled - a[1].settled)
  .map(([route, s]) => route + ' $' + s.usdc + ' (' + s.settled + ')')
  .join(', ');
console.log([
  'date=' + date,
  'revenue=$' + report.revenue.totalUsdc,
  'settled=' + report.funnel.settled,
  'payers unique=' + report.payers.unique + ' new=' + report.payers.new + ' returning=' + report.payers.returning + ' allTime=' + report.payers.allTime,
  'funnel challenges=' + report.funnel.challenges + ' rejected=' + report.funnel.rejected + ' unconfirmed=' + report.funnel.unconfirmed + ' failed=' + report.funnel.failed,
  'embeddings requests=' + report.embeddings.requests + ' success=' + report.embeddings.success + ' errors=' + report.embeddings.errors,
  'routes: ' + (topRoutes || 'none'),
  'report: ' + file,
].join('\n'));
