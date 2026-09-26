import { readFileSync } from 'node:fs';
import { x402Client } from '@x402/core/client';
import { registerExactSvmScheme } from '@x402/svm/exact/client';
import { createKeyPairSignerFromBytes } from '@solana/kit';
import { base58 } from '@scure/base';

const url = 'https://sol.mapleai.shop/api/v1/ethereum-mainnet/nft/getNFTMetadata' +
  '?contractAddress=0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D';
const network = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const asset = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const payTo = '9DbpH2Mf9D26ak4bASsv6KA4Ra4V571oLpiVdZjAjcU8';
const wallet = JSON.parse(readFileSync('.secrets/solana-test-wallet.json', 'utf8'));

function decode(header) {
  if (!header) throw new Error('Missing x402 header');
  return JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
}

const first = await fetch(url, { signal: AbortSignal.timeout(30_000) });
if (first.status !== 402) throw new Error('Expected 402, received ' + first.status);
const challenge = decode(first.headers.get('payment-required'));
const requirement = challenge.accepts?.[0];
if (challenge.x402Version !== 2 || challenge.resource?.url !== url || challenge.accepts?.length !== 1 ||
    requirement?.scheme !== 'exact' || requirement.network !== network || requirement.asset !== asset ||
    requirement.payTo !== payTo || requirement.amount !== '2000') {
  throw new Error('Unexpected payment requirement');
}
console.log('challenge: 402, price: $0.002 USDC');

const client = new x402Client().setSpendControls({
  allowedAssets: [{ network, asset, maxAmountPerPayment: '2000' }],
});
registerExactSvmScheme(client, {
  signer: await createKeyPairSignerFromBytes(base58.decode(wallet.privateKeyBase58)),
  networks: [network],
});
const payment = await client.createPaymentPayload(challenge);
delete payment.extensions?.quote;
const paid = await fetch(url, {
  headers: { 'payment-signature': Buffer.from(JSON.stringify(payment)).toString('base64') },
  signal: AbortSignal.timeout(120_000),
});
const receipt = paid.headers.get('payment-response') ? decode(paid.headers.get('payment-response')) : undefined;
const body = await paid.json();
console.log(JSON.stringify({
  status: paid.status,
  settled: receipt?.success === true,
  transaction: receipt?.transaction,
  error: body.error,
  metadata: body.object === 'nft_contract_metadata' ? {
    chainNetwork: body.chainNetwork,
    contractAddress: body.contractAddress,
    name: body.name,
    symbol: body.symbol,
    tokenType: body.tokenType,
    supportsERC721: body.supportsERC721,
  } : undefined,
}));
if (paid.status !== 200 || !receipt?.success || body.object !== 'nft_contract_metadata') process.exitCode = 1;
