#!/usr/bin/env node
import { networks, paidChat, type Network } from './server.js';

function option(args: string[], name: string, fallback: string): string {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error('Missing value for ' + name);
  return value;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    process.stdout.write('Usage: mapleai-quickstart [--network polygon|base|arc|solana] [--model ID] [--prompt TEXT] [--max-tokens N] [--pay]' + String.fromCharCode(10));
    return;
  }
  const name = option(args, '--network', 'polygon') as Network;
  if (!(name in networks)) throw new Error('Unsupported network: ' + name);
  const target = networks[name];
  const model = option(args, '--model', 'openai/gpt-6-luna');
  const prompt = option(args, '--prompt', 'Say hello in one sentence.');
  const maxTokens = Number(option(args, '--max-tokens', '64'));
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 16384) throw new Error('--max-tokens must be 1..16384');
  const modelsResponse = await fetch(target.origin + '/v1/models', { signal: AbortSignal.timeout(15_000) });
  if (!modelsResponse.ok) throw new Error('Models endpoint returned HTTP ' + modelsResponse.status);
  const models = await modelsResponse.json() as { data?: { id: string }[] };
  if (!models.data?.some(item => item.id === model)) throw new Error('Model is not listed by this API: ' + model);

  const body = JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens });
  const response = await fetch(target.origin + '/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(30_000),
  });
  if (response.status !== 402) throw new Error('Expected HTTP 402, got ' + response.status);
  const encoded = response.headers.get('payment-required');
  if (!encoded) throw new Error('Missing PAYMENT-REQUIRED header');
  const challenge = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as {
    x402Version?: number;
    resource?: { url?: string };
    accepts?: { scheme?: string; network?: string; asset?: string; payTo?: string; amount?: string }[];
  };
  const requirement = challenge.accepts?.[0];
  const expectedUrl = target.origin + '/v1/chat/completions';
  const equalAsset = name === 'solana' ? requirement?.asset === target.asset : requirement?.asset?.toLowerCase() === target.asset.toLowerCase();
  if (challenge.x402Version !== 2 || challenge.resource?.url !== expectedUrl || challenge.accepts?.length !== 1 ||
    requirement?.scheme !== 'exact' || requirement.network !== target.id || !equalAsset ||
    !requirement.payTo || !requirement.amount || !/^\d+$/.test(requirement.amount)) {
    throw new Error('Invalid x402 quote');
  }
  process.stdout.write(JSON.stringify({ model, network: requirement.network, asset: requirement.asset,
    payTo: requirement.payTo, quoted_usdc: Number(requirement.amount) / 1_000_000 }, null, 2) + String.fromCharCode(10));
  if (!args.includes('--pay')) {
    process.stdout.write('Quote only. Add --pay to sign and send a payment from the local wallet.' + String.fromCharCode(10));
    return;
  }
  const result = await paidChat(name, body);
  process.stdout.write(JSON.stringify(result, null, 2) + String.fromCharCode(10));
}

main().catch(error => { process.stderr.write(String(error) + String.fromCharCode(10)); process.exitCode = 1; });
