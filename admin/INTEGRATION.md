# MapleAI admin workspace

This directory contains the complete admin and prepaid marketplace application copied from the source project. It keeps the original Next.js routes, SQLite database modules, prepaid key issuance and SIWE wallet login.

## Wallet-only admin login

Set these values in `admin/.env` before starting the app:

```dotenv
JWT_SECRET=generate-a-long-random-secret
ADMIN_WALLET_ADDRESSES=0xYourAdminEvmWallet
DATA_DIR=/var/lib/mapleai-admin
PORT=4031
```

`ADMIN_WALLET_ADDRESSES` is an allowlist. The login flow issues a one-time SIWE nonce, verifies the wallet signature, checks the address against that allowlist, and sets an HttpOnly session cookie. A wallet outside the list cannot enter the admin dashboard.

## Start

```sh
cd admin
npm ci
npm run build
PORT=4031 npm run start
```

Transferred routes include `/dashboard/marketplace`, `/dashboard/prepaid`, prepaid key issuance/checking and wallet nonce/verify routes. The parent gateway remains the x402 API; this workspace is the management and prepaid-code service using the transferred project mechanics.

