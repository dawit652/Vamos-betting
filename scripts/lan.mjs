#!/usr/bin/env node
/**
 * Points the development stack at this computer's address on the local network, so phones on the
 * same Wi-Fi can open the player app, and the back office can be opened from the same address.
 *
 *   node scripts/lan.mjs                    find the address and write the settings
 *   node scripts/lan.mjs --ip 192.168.1.20  use this address instead
 *   node scripts/lan.mjs --reset            back to localhost
 *
 * Why it is needed: the API accepts browsers from exactly one player address (PUBLIC_WEB_URL) and one
 * back office address (ADMIN_WEB_URL), and the web apps learn where the API is from NEXT_PUBLIC_API_URL.
 * All three default to localhost, which on a phone means the phone itself. This script writes the three
 * values into `.env` and the web apps' `.env.local` files. Demo mode only: the stack stays on plain http.
 */
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = join(root, '.env');
const LOCAL_FILES = [join(root, 'apps/web/.env.local'), join(root, 'apps/admin/.env.local')];
const MARKER = '# Written by scripts/lan.mjs (run `node scripts/lan.mjs --reset` to remove).';

const say = (text) => process.stdout.write(`${text}\n`);

const API_PORT = 4000;
const WEB_PORT = 3000;
const ADMIN_PORT = 3001;

/** Network adapters that are not the Wi-Fi or cable a phone can reach (virtual machines, containers, VPNs). */
const VIRTUAL =
  /docker|veth|br-|virbr|vboxnet|vmnet|vethernet|wsl|hyper-v|utun|tailscale|zerotier|loopback|vpn|tun\d|tap\d/i;

/** Private addresses first, the usual home Wi-Fi range before the rest. */
function rank(address) {
  if (address.startsWith('192.168.')) return 0;
  if (address.startsWith('10.')) return 1;
  const second = Number(address.split('.')[1]);
  if (address.startsWith('172.') && second >= 16 && second <= 31) return 2;
  return 3;
}

function candidates() {
  const found = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    if (VIRTUAL.test(name)) continue;
    for (const entry of list ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      if (entry.address.startsWith('169.254.')) continue; // no network (self-assigned)
      found.push({ name, address: entry.address });
    }
  }
  return found.sort((a, b) => rank(a.address) - rank(b.address));
}

function setKey(text, key, value) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  if (pattern.test(text)) return text.replace(pattern, line);
  return `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${line}\n`;
}

function writeSettings(host) {
  if (!existsSync(ENV_FILE)) {
    const example = join(root, '.env.example');
    if (!existsSync(example)) throw new Error('.env and .env.example are both missing');
    copyFileSync(example, ENV_FILE);
    say('Created .env from .env.example.');
  }
  let env = readFileSync(ENV_FILE, 'utf8');
  env = setKey(env, 'PUBLIC_API_URL', `http://${host}:${API_PORT}`);
  env = setKey(env, 'PUBLIC_WEB_URL', `http://${host}:${WEB_PORT}`);
  env = setKey(env, 'ADMIN_WEB_URL', `http://${host}:${ADMIN_PORT}`);
  writeFileSync(ENV_FILE, env);
  for (const file of LOCAL_FILES) {
    writeFileSync(
      file,
      `${MARKER}
NEXT_PUBLIC_API_URL=http://${host}:${API_PORT}
`,
    );
  }
}

function reset() {
  if (existsSync(ENV_FILE)) {
    let env = readFileSync(ENV_FILE, 'utf8');
    env = setKey(env, 'PUBLIC_API_URL', `http://localhost:${API_PORT}`);
    env = setKey(env, 'PUBLIC_WEB_URL', `http://localhost:${WEB_PORT}`);
    env = setKey(env, 'ADMIN_WEB_URL', `http://localhost:${ADMIN_PORT}`);
    writeFileSync(ENV_FILE, env);
  }
  for (const file of LOCAL_FILES) {
    if (existsSync(file) && readFileSync(file, 'utf8').startsWith(MARKER)) rmSync(file);
  }
  say(
    'Back to localhost. Rebuild and restart the stack (pnpm phones:build, then pnpm phones:start).',
  );
}

const args = process.argv.slice(2);
if (args.includes('--reset')) {
  reset();
  process.exit(0);
}

const ipFlag = args.indexOf('--ip');
let host;
if (ipFlag >= 0) {
  host = args[ipFlag + 1];
  if (host === undefined || !/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    console.error('Usage: node scripts/lan.mjs --ip 192.168.1.20');
    process.exit(2);
  }
} else {
  const found = candidates();
  if (found.length === 0) {
    console.error(
      'No network address found. Connect the computer to the Wi-Fi (or cable) the phones use, or pass the address with --ip.',
    );
    process.exit(1);
  }
  host = found[0].address;
  if (found.length > 1) {
    say('This computer has several network addresses:');
    for (const { name, address } of found) say(`  ${address}  (${name})`);
    say(
      `Using ${host}. If phones cannot connect, pass the right one: node scripts/lan.mjs --ip <address>\n`,
    );
  }
}

writeSettings(host);
say(`Settings written for ${host}.

Build and start the stack (pnpm phones:build, then pnpm phones:start), then open:

  On every phone (same Wi-Fi):   http://${host}:${WEB_PORT}
  Back office (this computer):   http://${host}:${ADMIN_PORT}

Open the sites by this address on this computer too, never by "localhost": the API accepts
browsers from exactly these addresses, and the login cookies belong to the address you use.
When you are done: node scripts/lan.mjs --reset
`);
