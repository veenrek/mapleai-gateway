import { readFileSync } from 'node:fs';
import { x402Client } from '@x402/core/client';
import { registerExactSvmScheme } from '@x402/svm/exact/client';
import { createKeyPairSignerFromBytes } from '@solana/kit';
import { base58 } from '@scure/base';

const url = 'https://sol.mapleai.shop/prepaid/codes';
const network = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const asset = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const payTo = '9DbpH2Mf9D26ak4bASsv6KA4Ra4V571oLpiVdZjAjcU8';
const purchase = { model: 'openai/gpt-6-luna', tokens: 100000 };
const wallet = JSON.parse(readFileSync('.secrets/solana-test-wallet.json', 'utf8'));

function decode(header) {
  if (!header) throw new Error('Missing x402 header');
  return JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
}

const first = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(purchase),
  signal: AbortSignal.timeout(30_000),
});
if (first.status !== 402) throw new Error('Expected 402, received ' + first.status);
const challenge = decode(first.headers.get('payment-required'));
const requirement = challenge.accepts?.[0];
if (challenge.x402Version !== 2 || requirement?.scheme !== 'exact' ||
    requirement.network !== network || requirement.asset !== asset ||
    requirement.payTo !== payTo || requirement.amount !== '8000') {
  throw new Error('Unexpected payment requirement: ' + JSON.stringify(requirement));
}
console.log('challenge: 402, price: $0.008 USDC');

const client = new x402Client().setSpendControls({
  allowedAssets: [{ network, asset, maxAmountPerPayment: '8000' }],
});
registerExactSvmScheme(client, {
  signer: await createKeyPairSignerFromBytes(base58.decode(wallet.privateKeyBase58)),
  networks: [network],
});
const payment = await client.createPaymentPayload(challenge);
delete payment.extensions?.quote;
const paid = await fetch(url, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'payment-signature': Buffer.from(JSON.stringify(payment)).toString('base64'),
  },
  body: JSON.stringify(purchase),
  signal: AbortSignal.timeout(120_000),
});
const receipt = paid.headers.get('payment-response') ? decode(paid.headers.get('payment-response')) : undefined;
const body = await paid.json();
console.log(JSON.stringify({
  status: paid.status,
  settled: receipt?.success === true,
  transaction: receipt?.transaction,
  codePrefix: typeof body.code === 'string' ? body.code.slice(0, 12) + '...' : null,
  model: body.model,
  tokens: body.tokens,
  apiBase: body.api_base,
  error: body.error,
}));
if (paid.status !== 201 || !receipt?.success || typeof body.code !== 'string') process.exitCode = 1;

// The issued code must authenticate against the apex prepaid endpoint.
if (typeof body.code === 'string') {
  const models = await fetch('https://mapleai.shop/v1/models', {
    headers: { authorization: 'Bearer ' + body.code },
    signal: AbortSignal.timeout(30_000),
  });
  const list = await models.json();
  console.log('apex /v1/models:', models.status, JSON.stringify(list.data?.map((m) => m.id)));
  if (models.status !== 200) process.exitCode = 1;
}
