#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { x402Client } from '@x402/core/client';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { registerExactSvmScheme } from '@x402/svm/exact/client';
import { createKeyPairSignerFromBytes } from '@solana/kit';
import { base58 } from '@scure/base';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { z } from 'zod';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const pkg = createRequire(import.meta.url)('../package.json') as { version: string };

export const networks = {
  base: { origin: 'https://base.mapleai.shop', id: 'eip155:8453', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
  polygon: { origin: 'https://polygon.mapleai.shop', id: 'eip155:137', asset: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' },
  arc: { origin: 'https://arc.mapleai.shop', id: 'eip155:5042', asset: '0x3600000000000000000000000000000000000000' },
  solana: { origin: 'https://sol.mapleai.shop', id: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
} as const;
export type Network = keyof typeof networks;

/** Prepaid keys (oms_buy_...) are global: every network domain forwards /prepaid/*
 *  to the same issuer (src/prepaid-bypass.ts in the gateway), so status and spending
 *  run same-origin on the network the caller picked — no x402, no wallet. */

export interface SpendCap { max: bigint; envName: string; raw: string }
function envCap(envName: string, fallback: string): SpendCap {
  const raw = process.env[envName] ?? fallback;
  if (!/^\d+(\.\d{1,6})?$/.test(raw)) throw new Error('Invalid ' + envName + ': expected a decimal USDC amount');
  const [whole, fraction = ''] = raw.split('.');
  return { max: BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0')), envName, raw };
}
/** Per-call cap for metered calls (chat, Jev, agent execution). */
export function limit(): SpendCap {
  return envCap('MCP_MAX_PAYMENT_USDC', '0.10');
}
/** Per-purchase cap for prepaid key packs. The default covers the largest pack
 *  (1M tokens of the most expensive model on sale, ~$2.80 + settlement fee). */
export function prepaidLimit(): SpendCap {
  return envCap('MCP_MAX_PREPAID_USDC', '3.00');
}
export function recipient(name: Network): string {
  const address = process.env['MCP_PAY_TO_' + name.toUpperCase()] ?? process.env.MCP_PAY_TO;
  if (!address || (name === 'solana' ? !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address) : !/^0x[0-9a-fA-F]{40}$/.test(address))) {
    throw new Error('Set MCP_PAY_TO_' + name.toUpperCase() + ' to the verified API recipient');
  }
  return address;
}
function sameAddress(a: string, b: string, name: Network): boolean {
  return name === 'solana' ? a === b : a.toLowerCase() === b.toLowerCase();
}
async function paymentClient(name: Network, cap: bigint) {
  const target = networks[name];
  const client = new x402Client().setSpendControls({
    allowedAssets: [{ network: target.id, asset: target.asset, maxAmountPerPayment: cap.toString() }],
  });
  if (name === 'solana') {
    const key = process.env.SVM_PRIVATE_KEY;
    if (!key) throw new Error('Set SVM_PRIVATE_KEY for Solana');
    const bytes = key.startsWith('[') ? Uint8Array.from(JSON.parse(key) as number[]) : base58.decode(key);
    registerExactSvmScheme(client, { signer: await createKeyPairSignerFromBytes(bytes), networks: [target.id] });
  } else {
    const key = process.env.EVM_PRIVATE_KEY;
    if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('Set EVM_PRIVATE_KEY to a 0x-prefixed private key');
    registerExactEvmScheme(client, { signer: privateKeyToAccount(key as Hex), networks: [target.id] });
  }
  return client;
}
function header(value: string | null, name: string): any {
  if (!value) throw new Error('Missing ' + name + ' header');
  return JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
}
interface PaidRaw {
  raw: string;
  contentType: string;
  payment: { network: string; amount_usdc: number; transaction: string | null };
}

interface PaidOptions { timeoutMs?: number; cap?: SpendCap }
export async function paidRequest(name: Network, path: string, body: string, opts: PaidOptions = {}): Promise<PaidRaw> {
  const target = networks[name];
  const url = target.origin + path;
  const payTo = recipient(name);
  const cap = opts.cap ?? limit();
  const headers = { 'content-type': 'application/json' };
  const first = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(30_000) });
  if (first.status !== 402) throw new Error('Expected x402 challenge, got HTTP ' + first.status);
  const challenge = header(first.headers.get('payment-required'), 'PAYMENT-REQUIRED');
  if (challenge.x402Version !== 2 || challenge.resource?.url !== url || !Array.isArray(challenge.accepts) || challenge.accepts.length !== 1) {
    throw new Error('Unexpected x402 challenge');
  }
  const requirement = challenge.accepts[0];
  if (requirement.scheme !== 'exact' || requirement.network !== target.id ||
    !sameAddress(requirement.asset ?? '', target.asset, name) ||
    !sameAddress(requirement.payTo ?? '', payTo, name) ||
    typeof requirement.amount !== 'string' || !/^\d+$/.test(requirement.amount)) {
    throw new Error('Payment requirement failed network, asset or recipient check');
  }
  const amount = BigInt(requirement.amount);
  if (amount < 1n) throw new Error('Payment requirement amount is zero');
  if (amount > cap.max) {
    throw new Error('Payment requirement ' + (Number(amount) / 1_000_000).toFixed(6) + ' USDC exceeds ' +
      cap.envName + '=' + cap.raw + '. Raise ' + cap.envName + ' in the MCP client env and retry.');
  }
  const client = await paymentClient(name, cap.max);
  const payload = await client.createPaymentPayload(challenge);
  // PayAI currently rejects this optional field without an info block.
  delete payload.extensions?.quote;
  const paid = await fetch(url, {
    method: 'POST', headers: { ...headers, 'payment-signature': Buffer.from(JSON.stringify(payload)).toString('base64') },
    body, signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
  });
  const settlement = paid.headers.get('payment-response') ? header(paid.headers.get('payment-response'), 'PAYMENT-RESPONSE') : undefined;
  const raw = await paid.text();
  if (!paid.ok) throw new Error('API HTTP ' + paid.status + ': ' + raw.slice(0, 500));
  if (settlement && settlement.success !== true) throw new Error('Payment settlement failed');
  return { raw, contentType: paid.headers.get('content-type') ?? '', payment: {
    network: target.id, amount_usdc: Number(requirement.amount) / 1_000_000, transaction: settlement?.transaction ?? null,
  } };
}

export async function paidCall(name: Network, path: string, body: string, opts: PaidOptions = {}) {
  const { raw, payment } = await paidRequest(name, path, body, opts);
  return { response: JSON.parse(raw) as unknown, payment };
}
export async function paidChat(name: Network, body: string) {
  return paidCall(name, '/v1/chat/completions', body);
}

export function createServer() {
const server = new McpServer({ name: 'mapleai', version: pkg.version });
const envNetwork = process.env.MCP_NETWORK;
if (envNetwork !== undefined && !(envNetwork in networks)) {
  throw new Error('MCP_NETWORK must be one of: ' + Object.keys(networks).join(', '));
}
const networkSchema = z.enum(['base', 'polygon', 'arc', 'solana']).default((envNetwork as Network | undefined) ?? 'polygon');

server.registerTool('list_models', {
  description: 'List MapleAI models and prices on a supported network. Free call.',
  inputSchema: { network: networkSchema },
}, async ({ network }) => {
  try {
    const response = await fetch(networks[network].origin + '/v1/models', { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error('Models endpoint returned HTTP ' + response.status);
    return { content: [{ type: 'text', text: await response.text() }] };
  } catch (error) { return { isError: true, content: [{ type: 'text', text: String(error) }] }; }
});

server.registerTool('embed_text', {
  description:
    'Free 2048-dim embeddings via NVIDIA nemotron-3-embed-1b. No payment. ' +
    'Send one string or up to 128 strings; use input_type "query" for questions and "passage" for documents. ' +
    'encoding_format "float" (default) returns number arrays, "base64" returns compact base64 vectors.',
  inputSchema: {
    input: z.union([z.string().min(1), z.array(z.string().min(1)).min(1).max(128)]),
    input_type: z.enum(['query', 'passage']).default('query'),
    encoding_format: z.enum(['float', 'base64']).optional(),
    network: networkSchema,
  },
}, async ({ input, input_type, encoding_format, network }) => {
  try {
    const response = await fetch(networks[network].origin + '/v1/embeddings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(encoding_format === undefined ? { input, input_type } : { input, input_type, encoding_format }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error('Embeddings endpoint returned HTTP ' + response.status + ': ' + (await response.text()).slice(0, 300));
    return { content: [{ type: 'text', text: await response.text() }] };
  } catch (error) { return { isError: true, content: [{ type: 'text', text: String(error) }] }; }
});

server.registerTool('chat_completion', {
  description: 'Call a MapleAI model with local x402 USDC payment. Maximum spend per call is MCP_MAX_PAYMENT_USDC (default 0.10).',
  inputSchema: {
    network: networkSchema,
    model: z.string().min(1),
    messages: z.array(z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string() })).min(1).max(64),
    max_tokens: z.number().int().min(1).max(16384).default(128),
  },
}, async ({ network, model, messages, max_tokens }) => {
  try {
    const result = await paidChat(network, JSON.stringify({ model, messages, max_tokens }));
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (error) { return { isError: true, content: [{ type: 'text', text: String(error) }] }; }
});

server.registerTool('jev_decide', {
  description:
    'Paid Jev structured decision (jev-latest): evaluate named questions against a state. ' +
    'About $0.001 per short call via x402 USDC. Each question needs type (noul, choice or score) and instructions.',
  inputSchema: {
    state: z.string().min(1),
    questions: z.record(z.string(), z.object({
      type: z.enum(['noul', 'choice', 'score']),
      instructions: z.string().min(1),
    })).refine((questions) => Object.keys(questions).length >= 1, { message: 'at least one named question is required' }),
    network: networkSchema,
  },
}, async ({ state, questions, network }) => {
  try {
    const result = await paidCall(network, '/jev', JSON.stringify({ model: 'jev-latest', state, questions }));
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (error) { return { isError: true, content: [{ type: 'text', text: String(error) }] }; }
});

server.registerTool('agent_execute', {
  description:
    'Paid autonomous agent execution: give a natural-language task, a multi-step agent reasons and calls tools ' +
    '(calculator, fetch_url, web_search via the keyless Exa index, data_analysis; on deployments with a sandbox ' +
    'executor also code_exec — python/javascript/typescript, $0.002 per call, max 3 per task). ' +
    'Engines: agents/oss-20b (cheap — $0.002 base + $0.0005/step) and agents/gpt-6-sol (premium — $0.004 base + $0.004/step). ' +
    'Charged at the max_steps ceiling plus allowed-tool fees; the worst case (20 steps + 3 code_exec, ~$0.09) ' +
    'still fits the default MCP_MAX_PAYMENT_USDC=0.10. With stream=true the reply contains the live SSE step transcript; ' +
    'the agent.execution object always includes the full step trace, sources, usage and charged_ceiling_usd.',
  inputSchema: {
    network: networkSchema,
    task: z.string().min(1).max(12000),
    model: z.enum(['agents/oss-20b', 'agents/gpt-6-sol']).default('agents/oss-20b'),
    context: z.string().max(12000).optional(),
    max_steps: z.number().int().min(1).max(20).default(8),
    tools: z.array(z.enum(['calculator', 'fetch_url', 'web_search', 'data_analysis', 'code_exec'])).optional(),
    stream: z.boolean().default(false),
  },
}, async ({ network, task, model, context, max_steps, tools, stream }) => {
  try {
    if (task.length + (context?.length ?? 0) > 16_000) {
      throw new Error('task + context must not exceed 16000 characters');
    }
    const body: Record<string, unknown> = { model, task, max_steps, stream };
    if (context !== undefined) body.context = context;
    if (tools !== undefined) body.tools = tools;
    const { raw, payment } = await paidRequest(network, '/v1/agents/execute', JSON.stringify(body), { timeoutMs: 540_000 + max_steps * 15_000 });
    if (!stream) return { content: [{ type: 'text', text: JSON.stringify({ execution: JSON.parse(raw), payment }) }] };
    // SSE: rebuild the transcript from open/step events and the final done payload.
    const transcript: string[] = [];
    let donePayload: unknown = null;
    for (const block of raw.split(/\r?\n\r?\n/)) {
      const evMatch = /^event: (\w+)\ndata: ([\s\S]*)$/.exec(block.trim());
      if (!evMatch) continue;
      const [, ev, dataRaw] = evMatch;
      try {
        const data = JSON.parse(dataRaw) as Record<string, unknown>;
        if (ev === 'open') transcript.push(`> ceiling charged: $${data.charged_ceiling_usd} | engine ${data.model} | steps max ${data.max_steps}`);
        if (ev === 'step') {
          const args = data.tool_call ? JSON.stringify((data.tool_call as { args?: unknown }).args ?? {}) : undefined;
          transcript.push(`step ${data.n}: ${data.thought ?? ''}` +
            (data.action === 'tool' ? `\n  tool ${(data.tool_call as { name?: string })?.name} ${args}` : '') +
            (typeof data.answer === 'string' ? `\n  answer: ${data.answer}` : ''));
        }
        if (ev === 'done') donePayload = data;
      } catch { /* keep raw block */ }
    }
    if (!donePayload) throw new Error('SSE done event missing: ' + raw.slice(0, 300));
    const header = transcript.length > 0 ? transcript.join('\n') + '\n\n' : '';
    return { content: [{ type: 'text', text: header + JSON.stringify({ execution: donePayload, payment }) }] };
  } catch (error) { return { isError: true, content: [{ type: 'text', text: String(error) }] }; }
});

server.registerTool('buy_prepaid_tap', {
  description:
    'Paid one-shot: buys a prepaid MapleAI API key with local x402 USDC. ' +
    'With no arguments it buys the smallest pack of the cheapest model currently on sale (about $0.008). ' +
    'Optional model (one of openai/gpt-5.6-sol, openai/gpt-5.6-terra, openai/gpt-6-luna, openai/gpt-6-sol, when on sale) ' +
    'and tokens (100000..1000000 in steps of 100000) pick a bigger pack: price = tokens x model input rate per million ' +
    '+ settlement fee, so 1M tokens of openai/gpt-6-sol is about $1.40 and the largest pack (1M of openai/gpt-5.6-sol) about $2.80. ' +
    'Purchases are capped by MCP_MAX_PREPAID_USDC (default 3.00, covers the largest pack) — not by MCP_MAX_PAYMENT_USDC. ' +
    'The key is an OpenAI-compatible Bearer credential at https://mapleai.shop/v1 — spend it there or with ' +
    'the prepaid_chat tool right here; the network gateways also accept it same-origin under /prepaid/v1/*. ' +
    'Store the returned code — it is the only credential.',
  inputSchema: {
    network: networkSchema,
    model: z.string().optional(),
    tokens: z.number().int().min(100_000).max(1_000_000).multipleOf(100_000).optional(),
  },
}, async ({ network, model, tokens }) => {
  try {
    const body: Record<string, unknown> = {};
    if (model !== undefined) body.model = model;
    if (tokens !== undefined) body.tokens = tokens;
    const result = await paidCall(network, '/prepaid/codes/auto', JSON.stringify(body), { cap: prepaidLimit() });
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (error) { return { isError: true, content: [{ type: 'text', text: String(error) }] }; }
});

server.registerTool('prepaid_status', {
  description:
    'Free: check a prepaid MapleAI key (valid flag, reason, tokens total/used/reserved/remaining). ' +
    'Send the oms_buy_ key bought via buy_prepaid_tap or the website. Keys are global — the check runs ' +
    'same-origin on the selected network (and identically at https://mapleai.shop/v1/prepaid/status).',
  inputSchema: {
    code: z.string().min(10),
    network: networkSchema,
  },
}, async ({ code, network }) => {
  try {
    const response = await fetch(networks[network].origin + '/prepaid/status', {
      headers: { authorization: 'Bearer ' + code },
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    if (response.status !== 200) throw new Error('Status endpoint returned HTTP ' + response.status + ': ' + text.slice(0, 200));
    return { content: [{ type: 'text', text }] };
  } catch (error) { return { isError: true, content: [{ type: 'text', text: String(error) }] }; }
});

server.registerTool('prepaid_chat', {
  description:
    'Chat completions paid from a prepaid key instead of x402: no wallet, no per-call payment — token spend is ' +
    'bounded by the key budget. Send the oms_buy_ code from buy_prepaid_tap (or the website) plus model and messages. ' +
    'The key is bound to one model; a wrong model is answered 403 with the key\'s allowedModels. ' +
    'Runs same-origin on the selected network at /prepaid/v1/chat/completions ' +
    '(and identically at https://mapleai.shop/v1/chat/completions).',
  inputSchema: {
    code: z.string().min(10),
    model: z.string().min(1),
    messages: z.array(z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string() })).min(1).max(64),
    max_tokens: z.number().int().min(1).max(16384).optional(),
    network: networkSchema,
  },
}, async ({ code, model, messages, max_tokens, network }) => {
  try {
    const body: Record<string, unknown> = { model, messages };
    if (max_tokens !== undefined) body.max_tokens = max_tokens;
    const response = await fetch(networks[network].origin + '/prepaid/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + code },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error('Prepaid chat returned HTTP ' + response.status + ': ' + text.slice(0, 500));
    return { content: [{ type: 'text', text }] };
  } catch (error) { return { isError: true, content: [{ type: 'text', text: String(error) }] }; }
});

return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await createServer().connect(new StdioServerTransport());
}
