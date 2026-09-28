import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({ command: 'node', args: ['dist/server.js'] });
const client = new Client({ name: 'smoke', version: '0.1.0' });
await client.connect(transport);

const tools = (await client.listTools()).tools.map((t) => t.name);
console.log('tools:', tools.join(', '));
if (tools.length !== 6) throw new Error('expected 6 tools, got ' + tools.length);
for (const expected of ['list_models', 'embed_text', 'prepaid_status', 'chat_completion', 'jev_decide', 'buy_prepaid_tap']) {
  if (!tools.includes(expected)) throw new Error('missing tool ' + expected);
}

const embed = await client.callTool({
  name: 'embed_text',
  arguments: { input: 'Hello agent', input_type: 'query', network: 'base' },
});
const embedText = embed.content?.[0]?.text ?? '';
const embedJson = JSON.parse(embedText);
if (!Array.isArray(embedJson.data) || embedJson.data.length !== 1) throw new Error('bad embeddings payload');
const vector = embedJson.data[0].embedding;
console.log('embed_text ok: dim=', vector.length, 'hint_next=', String(embedJson.hint_next || '').slice(0, 40));

const status = await client.callTool({ name: 'prepaid_status', arguments: { code: 'oms_buy_invalid_test' } });
const statusText = status.content?.[0]?.text ?? '';
if (!status.isError) throw new Error('invalid key should produce an error result');
console.log('prepaid_status( invalid key ) -> error path ok:', statusText.slice(0, 60));

await client.close();
console.log('SMOKE OK');
