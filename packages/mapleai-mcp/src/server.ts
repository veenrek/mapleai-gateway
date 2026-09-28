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

export const networks = {
  base: { origin: 'https://base.mapleai.shop', id: 'eip155:8453', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
  polygon: { origin: 'https://polygon.mapleai.shop', id: 'eip155:137', asset: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' },
  arc: { origin: 'https://arc.mapleai.shop', id: 'eip155:5042', asset: '0x3600000000000000000000000000000000000000' },
  solana: { origin: 'https://sol.mapleai.shop', id: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
} as const;
export type Network = keyof typeof networks;

const PREPAID_API_BASE = 'https://mapleai.shop/v1';

export function limit(): bigint {
  const raw = process.env.MCP_MAX_PAYMENT_USDC ?? '0.10';
  if (!/^\d+(\.\d{1,6})?$/.test(raw)) throw new Error('Invalid MCP_MAX_PAYMENT_USDC');
  const [whole, fraction = ''] = raw.split('.');
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
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
export async function paidCall(name: Network, path: string, body: string) {
  const target = networks[name];
  const url = target.origin + path;
  const payTo = recipient(name);
  const cap = limit();
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
    typeof requirement.amount !== 'string' || !/^\d+$/.test(requirement.amount) ||
    BigInt(requirement.amount) < 1n || BigInt(requirement.amount) > cap) {
    throw new Error('Payment requirement failed network, asset, recipient or amount check');
  }
  const client = await paymentClient(name, cap);
  const payload = await client.createPaymentPayload(challenge);
  // PayAI currently rejects this optional field without an info block.
  delete payload.extensions?.quote;
  const paid = await fetch(url, {
    method: 'POST', headers: { ...headers, 'payment-signature': Buffer.from(JSON.stringify(payload)).toString('base64') },
    body, signal: AbortSignal.timeout(120_000),
  });
  const settlement = paid.headers.get('payment-response') ? header(paid.headers.get('payment-response'), 'PAYMENT-RESPONSE') : undefined;
  const raw = await paid.text();
  if (!paid.ok) throw new Error('API HTTP ' + paid.status + ': ' + raw.slice(0, 500));
  if (settlement && settlement.success !== true) throw new Error('Payment settlement failed');
  return { response: JSON.parse(raw) as unknown, payment: {
    network: target.id, amount_usdc: Number(requirement.amount) / 1_000_000, transaction: settlement?.transaction ?? null,
  } };
}
export async function paidChat(name: Network, body: string) {
  return paidCall(name, '/v1/chat/completions', body);
}

export function createServer() {
const server = new McpServer({ name: 'mapleai', version: '0.2.0' });
const networkSchema = z.enum(['base', 'polygon', 'arc', 'solana']).default('polygon');

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
    'Send one string or up to 4 strings; use input_type "query" for questions and "passage" for documents.',
  inputSchema: {
    input: z.union([z.string().min(1), z.array(z.string().min(1)).min(1).max(4)]),
    input_type: z.enum(['query', 'passage']).default('query'),
    network: networkSchema,
  },
}, async ({ input, input_type, network }) => {
  try {
    const response = await fetch(networks[network].origin + '/v1/embeddings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input, input_type }),
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

server.registerTool('buy_prepaid_tap', {
  description:
    'Paid one-shot: buys a prepaid MapleAI API key (default 100000 tokens of openai/gpt-6-luna) with local x402 USDC. ' +
    'An empty purchase costs about $0.008. The key works at https://mapleai.shop/v1 as an OpenAI-compatible Bearer credential. ' +
    'Store the returned code — it is the only credential.',
  inputSchema: {
    network: networkSchema,
    model: z.string().optional(),
    tokens: z.number().int().min(100_000).max(1_000_000).optional(),
  },
}, async ({ network, model, tokens }) => {
  try {
    const body: Record<string, unknown> = {};
    if (model !== undefined) body.model = model;
    if (tokens !== undefined) body.tokens = tokens;
    const result = await paidCall(network, '/prepaid/codes/auto', JSON.stringify(body));
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (error) { return { isError: true, content: [{ type: 'text', text: String(error) }] }; }
});

server.registerTool('prepaid_status', {
  description:
    'Free: check a prepaid MapleAI key (valid flag, reason, tokens total/used/reserved/remaining). ' +
    'Send the oms_buy_ key bought via buy_prepaid_tap or the website.',
  inputSchema: {
    code: z.string().min(10),
  },
}, async ({ code }) => {
  try {
    const response = await fetch(PREPAID_API_BASE + '/prepaid/status', {
      headers: { authorization: 'Bearer ' + code },
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    if (response.status !== 200) throw new Error('Status endpoint returned HTTP ' + response.status + ': ' + text.slice(0, 200));
    return { content: [{ type: 'text', text }] };
  } catch (error) { return { isError: true, content: [{ type: 'text', text: String(error) }] }; }
});

return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await createServer().connect(new StdioServerTransport());
}
