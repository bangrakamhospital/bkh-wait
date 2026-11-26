#!/usr/bin/env node
// Make one WAIT_USERS entry (username:role:scrypt-hash).
//
//   node scripts/hash-password.mjs <username> <staff|partner>
//
// The password is read from stdin (typed with echo off on a TTY, or piped),
// never from the command line, so it does not end up in shell history / ps.
// Paste the printed entry into WAIT_USERS in .env (comma separated), then
// `pm2 restart bkh-wait --update-env`.

import { randomBytes, scrypt } from "node:crypto";

const [username, role] = process.argv.slice(2);
if (!username || !/^[a-z0-9_.-]{2,32}$/.test(username.toLowerCase()) || !["staff", "partner"].includes(role)) {
  console.error("usage: node scripts/hash-password.mjs <username [a-z0-9_.-]{2,32}> <staff|partner>");
  process.exit(2);
}

async function readPassword() {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    let data = "";
    for await (const chunk of stdin) data += chunk;
    return data.replace(/\r?\n$/, "");
  }
  process.stderr.write("password: ");
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve) => {
    let pw = "";
    stdin.on("data", (ch) => {
      if (ch === "\r" || ch === "\n" || ch === "\u0004") {
        stdin.setRawMode(false);
        stdin.pause();
        process.stderr.write("\n");
        resolve(pw);
      } else if (ch === "\u0003") {
        process.exit(130);
      } else if (ch === "\u007f" || ch === "\b") {
        pw = pw.slice(0, -1);
      } else {
        pw += ch;
      }
    });
  });
}

const password = await readPassword();
if (password.length < 10 || password.length > 256) {
  console.error("password must be 10-256 characters");
  process.exit(2);
}
const N = 16384;
const r = 8;
const p = 1;
const salt = randomBytes(16);
const key = await new Promise((resolve, reject) =>
  scrypt(password, salt, 32, { N, r, p }, (err, k) => (err ? reject(err) : resolve(k))),
);
console.log(`${username.toLowerCase()}:${role}:scrypt.${N}.${r}.${p}.${salt.toString("base64url")}.${key.toString("base64url")}`);
