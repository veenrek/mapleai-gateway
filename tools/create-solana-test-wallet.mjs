import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { base58 } from '@scure/base';
import { createKeyPairSignerFromPrivateKeyBytes } from '@solana/kit';

const output = resolve(dirname(fileURLToPath(import.meta.url)), '../.secrets/solana-test-wallet.json');
const seed = randomBytes(32);
const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', signer.keyPair.publicKey));
const keypair = new Uint8Array(64);
keypair.set(seed);
keypair.set(publicKey, 32);
const secret = base58.encode(keypair);
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify({ address: signer.address, privateKeyBase58: secret, network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' }) + String.fromCharCode(10), { mode: 0o600, flag: 'wx' });
try { chmodSync(output, 0o600); } catch { /* Windows ACLs are managed by the user profile. */ }
process.stdout.write(JSON.stringify({ address: signer.address, network: 'Solana mainnet', secretFile: output }) + String.fromCharCode(10));
