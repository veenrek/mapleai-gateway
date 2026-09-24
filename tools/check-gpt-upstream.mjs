import { readFileSync } from 'node:fs';
const env = Object.fromEntries(readFileSync('/opt/claude-api-sol/.env', 'utf8')
  .split(/\r?\n/).filter((line) => /^[A-Z_]+=/.test(line))
  .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
const headers = { authorization: 'Bearer ' + env.UPSTREAM_API_KEY };
const response = await fetch(env.UPSTREAM_BASE_URL + '/models', { headers });
const data = await response.json().catch(() => ({}));
console.log(JSON.stringify({ status: response.status, count: data.data?.length,
  gpt: data.data?.map((m) => m.id).filter((id) => /gpt-(5\.6|6)/.test(id)) }));
for (const model of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-6-luna', 'gpt-6-sol']) {
  const result = await fetch(env.UPSTREAM_BASE_URL + '/chat/completions', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply OK' }], max_tokens: 16 }),
    signal: AbortSignal.timeout(45000),
  });
  const answer = await result.json().catch(() => ({}));
  console.log(JSON.stringify({ model, status: result.status, hasChoice: !!answer.choices?.[0],
    errorType: answer.error?.type ?? answer.error?.code }));
}
