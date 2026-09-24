import { readFileSync } from 'node:fs';

const env = Object.fromEntries(readFileSync('/opt/claude-api-sol/.env', 'utf8')
  .split(/\r?\n/).filter((line) => /^[A-Z_]+=/.test(line))
  .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
const mapping = JSON.parse(env.MODEL_MAPPING);
const model = mapping['anthropic/claude-haiku-4.5'];
const response = await fetch(env.UPSTREAM_BASE_URL + '/chat/completions', {
  method: 'POST',
  headers: { authorization: 'Bearer ' + env.UPSTREAM_API_KEY, 'content-type': 'application/json' },
  body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply OK' }], max_tokens: 16 }),
});
const data = await response.json().catch(() => ({}));
console.log(JSON.stringify({ status: response.status, model, hasChoice: !!data.choices?.[0],
  errorType: data.error?.type ?? data.error?.code }));
