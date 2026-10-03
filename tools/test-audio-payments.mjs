// Paid end-to-end test of the audio routes with the dev wallets in .secrets/:
//   node tools/test-audio-payments.mjs base
//   node tools/test-audio-payments.mjs solana
// Buys one TTS call and one STT call (~$0.021 total) against the prod gateways,
// checking the 402 challenge shape, settlement receipt and audio payloads.
import { readFileSync, writeFileSync } from 'node:fs';
import { x402Client } from '@x402/core/client';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { registerExactSvmScheme } from '@x402/svm/exact/client';
import { privateKeyToAccount } from 'viem/accounts';
import { createKeyPairSignerFromBytes } from '@solana/kit';
import { base58 } from '@scure/base';

const network = process.argv[2];
if (!['base', 'solana'].includes(network)) {
  console.error('usage: node tools/test-audio-payments.mjs base|solana');
  process.exit(1);
}

const CONF = {
  base: {
    origin: 'https://base.mapleai.shop',
    network: 'eip155:8453',
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    walletPath: '.secrets/base-buyer-wallet.json',
  },
  solana: {
    origin: 'https://sol.mapleai.shop',
    network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    walletPath: '.secrets/solana-test-wallet.json',
  },
}[network];

const CAP = 50_000n; // $0.05 hard spend ceiling per payment
const cfg = CONF;
const wallet = JSON.parse(readFileSync(cfg.walletPath, 'utf8'));

const client = new x402Client().setSpendControls({
  allowedAssets: [{ network: cfg.network, asset: cfg.asset, maxAmountPerPayment: CAP.toString() }],
});
if (network === 'base') {
  registerExactEvmScheme(client, {
    signer: privateKeyToAccount(wallet.privateKey),
    networks: [cfg.network],
  });
} else {
  registerExactSvmScheme(client, {
    signer: await createKeyPairSignerFromBytes(base58.decode(wallet.privateKeyBase58)),
    networks: [cfg.network],
  });
}

const decode = (v) => JSON.parse(Buffer.from(v, 'base64').toString('utf8'));

async function payAndFetch(path, init) {
  const url = cfg.origin + path;
  const first = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  if (first.status !== 402) {
    throw new Error(`${path}: expected 402, got ${first.status}: ${(await first.text()).slice(0, 200)}`);
  }
  const challenge = decode(first.headers.get('payment-required'));
  const requirement = challenge.accepts?.[0];
  if (!requirement || requirement.scheme !== 'exact' || requirement.network !== cfg.network ||
      requirement.asset !== cfg.asset || !/^[0-9]+$/.test(requirement.amount) ||
      BigInt(requirement.amount) > CAP) {
    throw new Error(`${path}: unacceptable payment requirement ${JSON.stringify(requirement)}`);
  }
  console.log(`${path} quote=$${Number(requirement.amount) / 1_000_000} payTo=${requirement.payTo.slice(0, 10)}…`);
  const payment = await client.createPaymentPayload(challenge);
  const retry = await fetch(url, {
    ...init,
    headers: { ...init.headers, 'payment-signature': Buffer.from(JSON.stringify(payment)).toString('base64') },
    signal: AbortSignal.timeout(300_000),
  });
  const receipt = retry.headers.get('payment-response') ? decode(retry.headers.get('payment-response')) : undefined;
  console.log(`${path} status=${retry.status} settled=${Boolean(receipt?.success)} tx=${(receipt?.transaction ?? 'none').slice?.(0, 20) || 'none'}`);
  return { response: retry, receipt };
}

// --- 1. TTS ---
const speechInit = {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    model: 'orpheus-english',
    input: '[laughs] A paid production call just served this voice.',
    voice: 'autumn',
    speed: 1.1,
  }),
};
const speech = await payAndFetch('/v1/audio/speech', speechInit);
const speechBody = Buffer.from(await speech.response.arrayBuffer());
if (speech.response.status !== 200 || speechBody.subarray(0, 4).toString() !== 'RIFF') {
  throw new Error(`speech failed: ${speechBody.subarray(0, 300).toString()}`);
}
const upstreamHeaders = `x-audio-upstream=${speech.response.headers.get('x-audio-upstream')} x-fallback-used=${speech.response.headers.get('x-fallback-used')}`;
writeFileSync(`audio-paid-${network}.wav`, speechBody);
console.log(`speech ok: ${speechBody.length} bytes ${upstreamHeaders}`);

// --- 2. STT (multipart, of the audio we just bought) ---
const buildForm = () => {
  const form = new FormData();
  form.set('model', 'whisper-large-v3-turbo');
  form.set('response_format', 'json');
  form.set('file', new Blob([speechBody], { type: 'audio/wav' }), 'paid.wav');
  return form;
};
const stt = await payAndFetch('/v1/audio/transcriptions', { method: 'POST', body: buildForm() });
const sttRaw = await stt.response.text();
let sttText = '';
try { sttText = JSON.parse(sttRaw).text; } catch { /* fall through */ }
if (stt.response.status !== 200 || !sttText) {
  throw new Error(`transcription failed: ${sttRaw.slice(0, 300)}`);
}
console.log(`stt ok: "${sttText.slice(0, 80)}" x-audio-upstream=${stt.response.headers.get('x-audio-upstream')} x-fallback-used=${stt.response.headers.get('x-fallback-used')}`);
console.log(`${network}: ALL PAID AUDIO CHECKS PASSED`);
