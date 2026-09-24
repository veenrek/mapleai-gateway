const fs = require('node:fs');

const [localPath, remotePath] = process.argv.slice(2);
if (!localPath || !remotePath) process.exit(2);

function parse(path) {
  return fs.readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean);
}

const local = new Map(parse(localPath).filter((line) => /^[A-Z_]+=/.test(line)).map((line) => {
  const i = line.indexOf('=');
  return [line.slice(0, i), line.slice(i + 1)];
}));
const update = ['UPSTREAM_BASE_URL', 'UPSTREAM_API_KEY', 'MODEL_PRICES', 'MODEL_MAPPING',
  'PRICE_MARKUP', 'OUTPUT_TOKEN_ESTIMATE', 'OUTPUT_TOKEN_CAP', 'FACILITATOR_FEE_USD',
  'MIN_CHARGE_USD'];
const lines = parse(remotePath);
const seen = new Set();
const merged = lines.map((line) => {
  const key = line.slice(0, line.indexOf('='));
  if (!update.includes(key) || !local.has(key)) return line;
  seen.add(key);
  return key + '=' + local.get(key);
});
for (const key of update) {
  if (local.has(key) && !seen.has(key)) merged.push(key + '=' + local.get(key));
}
fs.writeFileSync(remotePath, merged.join('\n') + '\n', { mode: 0o600 });
