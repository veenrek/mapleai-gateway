import { readFileSync, writeFileSync } from 'node:fs';
import { x402Client } from '@x402/core/client';
import { registerExactSvmScheme } from '@x402/svm/exact/client';
import { createKeyPairSignerFromBytes } from '@solana/kit';
import { base58 } from '@scure/base';

const origin = 'https://sol.mapleai.shop';
const network = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const asset = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const payTo = '9DbpH2Mf9D26ak4bASsv6KA4Ra4V571oLpiVdZjAjcU8';
const cap = 30_000n;
const wallet = JSON.parse(readFileSync('.secrets/solana-test-wallet.json', 'utf8'));
const client = new x402Client().setSpendControls({
  allowedAssets: [{ network, asset, maxAmountPerPayment: cap.toString() }],
});
registerExactSvmScheme(client, {
  signer: await createKeyPairSignerFromBytes(base58.decode(wallet.privateKeyBase58)),
  networks: [network],
});

function decode(value) {
  if (!value) throw new Error('Missing x402 response header');
  return JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
}

async function call(path, payload) {
  const url = origin + path;
  const body = JSON.stringify(payload);
  const headers = { 'content-type': 'application/json' };
  const first = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(30_000) });
  if (first.status !== 402) throw new Error(path + ': expected 402, got ' + first.status);
  const challenge = decode(first.headers.get('payment-required'));
  const requirement = challenge.accepts?.[0];
  if (challenge.x402Version !== 2 || challenge.resource?.url !== url || challenge.accepts?.length !== 1 ||
      requirement.scheme !== 'exact' || requirement.network !== network || requirement.asset !== asset ||
      requirement.payTo !== payTo || !/^[0-9]+$/.test(requirement.amount) ||
      BigInt(requirement.amount) > cap || BigInt(requirement.amount) < 1n) {
    throw new Error(path + ': invalid payment requirement');
  }
  console.log(path + ' quote=' + Number(requirement.amount) / 1_000_000 + ' USDC');
  const payment = await client.createPaymentPayload(challenge);
  delete payment.extensions?.quote;
  const signedTransaction = payment.payload?.transaction;
  if (typeof signedTransaction === 'string') {
    const simulation = await fetch('https://api.mainnet-beta.solana.com', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1,
        method: 'simulateTransaction', params: [signedTransaction, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true }] }),
      signal: AbortSignal.timeout(20_000),
    });
    const result = await simulation.json();
    console.log(path + ' simulation=' + JSON.stringify({ error: result.error, err: result.result?.value?.err,
      logs: result.result?.value?.logs?.slice(-8) }));
  }
  const response = await fetch(url, { method: 'POST', headers: {
    ...headers, 'payment-signature': Buffer.from(JSON.stringify(payment)).toString('base64'),
  }, body, signal: AbortSignal.timeout(210_000) });
  const receipt = response.headers.get('payment-response') ? decode(response.headers.get('payment-response')) : undefined;
  const raw = await response.text();
  console.log(path + ' status=' + response.status + ' settled=' + Boolean(receipt?.success) +
    ' tx=' + (receipt?.transaction ?? 'none'));
  if (!response.ok || !receipt?.success) {
    const refusal = response.headers.get('payment-required');
    if (refusal) console.log(path + ' payment_error=' + decode(refusal).error);
    console.log(path + ' error=' + raw.slice(0, 500));
    throw new Error(path + ': response or settlement failed');
  }
  const result = JSON.parse(raw);
  if (!Array.isArray(result.data) || result.data.length !== 1 ||
      (typeof result.data[0].url !== 'string' && typeof result.data[0].b64_json !== 'string')) {
    throw new Error(path + ': invalid image response');
  }
  return { result, receipt };
}

async function imageBytes(item) {
  if (typeof item.b64_json === 'string') return Buffer.from(item.b64_json, 'base64');
  const response = await fetch(item.url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error('Image download failed: HTTP ' + response.status);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 10_000_000) throw new Error('Image larger than edit limit');
  return bytes;
}

function mime(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) return 'image/jpeg';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  throw new Error('Unknown generated image format');
}

let firstBytes;
if (process.argv.includes('--edit-only')) {
  firstBytes = readFileSync('.secrets/image-generation-test.png');
} else {
  const generated = await call('/api/v1/images/generations', {
    model: 'gpt-image-2', size: '1024x1024', n: 1,
    prompt: 'A red maple leaf on a plain white background, centered, simple product photo.',
  });
  firstBytes = await imageBytes(generated.result.data[0]);
}
const imageType = mime(firstBytes);
const suffix = imageType.split('/')[1];
writeFileSync('.secrets/image-generation-test.' + suffix, firstBytes);
console.log('generation bytes=' + firstBytes.length + ' mime=' + imageType);

const edited = await call('/api/v1/images/image2image', {
  model: 'gpt-image-2', size: '1024x1024', n: 1,
  prompt: 'Change the maple leaf from red to green. Keep the white background and composition.',
  image: 'data:' + imageType + ';base64,' + firstBytes.toString('base64'),
});
const editedBytes = await imageBytes(edited.result.data[0]);
const editedType = mime(editedBytes);
writeFileSync('.secrets/image-edit-test.' + editedType.split('/')[1], editedBytes);
console.log('edit bytes=' + editedBytes.length + ' mime=' + editedType);
