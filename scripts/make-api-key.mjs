#!/usr/bin/env node
// Make one key for the central API (/api/v1/*).
//
//   node scripts/make-api-key.mjs <name>
//
// Prints the key ONCE (give it to the central system over a safe channel)
// and the WAIT_API_KEYS entry `name:sha256hex` for the server's .env (only
// the hash is stored). Append it to WAIT_API_KEYS (comma separated), then
// `pm2 restart bkh-wait --update-env`. To revoke: delete the entry.

import { createHash, randomBytes } from "node:crypto";

const name = (process.argv[2] ?? "").toLowerCase();
if (!/^[a-z0-9][a-z0-9_.-]{1,31}$/.test(name)) {
  console.error("usage: node scripts/make-api-key.mjs <name [a-z0-9_.-]{2,32}, e.g. moph-region3>");
  process.exit(2);
}
const key = `bkw_${randomBytes(32).toString("base64url")}`;
const hash = createHash("sha256").update(key).digest("hex");
console.log(`key (shown once):      ${key}`);
console.log(`WAIT_API_KEYS entry:   ${name}:${hash}`);
