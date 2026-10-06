#!/usr/bin/env node
// Generates a DroidBridge relay device key and the SHA-256 the relay stores as a secret.
// The key goes into the app; only its hash goes to Cloudflare.
//
//   node scripts/new-device-key.mjs
//
// Uses node:crypto so it runs on any Node release Wrangler supports.

import { createHash, randomBytes } from 'node:crypto';

const key = `dbrk_${randomBytes(32).toString('base64url')}`;
const hash = createHash('sha256').update(key, 'utf8').digest('hex');

if (!/^dbrk_[A-Za-z0-9_-]{43}$/.test(key) || !/^[0-9a-f]{64}$/.test(hash)) {
  console.error('Could not generate a well-formed device key.');
  process.exit(1);
}

process.stdout.write(`DroidBridge relay device key

1. Device key. Paste it into DroidBridge (Agent connection > Claude connector > Device key):

   ${key}

2. Its SHA-256. In this folder, run the command below and paste the hash when Wrangler asks:

   npx wrangler@4 secret put DEVICE_KEY_SHA256

   ${hash}

Treat the device key like a password: anyone holding it can act as your phone toward the relay.
The relay only ever stores the hash. To rotate the key, run this script again, store the new
hash with the same command, and paste the new key into DroidBridge.
`);
