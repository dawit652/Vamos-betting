// Removes the demo wording from the two static files of the player site that cannot read the operating mode
// at runtime: `manifest.webmanifest` (the installed app's name and description) and `offline.html` (its demo
// banner). The Dockerfile runs it before `next build` when NEXT_PUBLIC_OPERATING_MODE=licensed; a demo build
// never runs it, so the play-money notices stay.
//
//   node apps/web/scripts/licensed-static.mjs [public directory]
//
// It throws when a file no longer has what it removes, so a later edit cannot silently leave the wording in.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function makeLicensed(publicDir) {
  const manifestPath = join(publicDir, 'manifest.webmanifest');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!/demo/i.test(manifest.name) || !/demo/i.test(manifest.description)) {
    throw new Error('manifest.webmanifest: the demo wording is not where this script expects it');
  }
  manifest.name = 'Nahubet – sports betting';
  manifest.description = 'Simple, fast sports betting for Ethiopia.';
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const offlinePath = join(publicDir, 'offline.html');
  const offline = readFileSync(offlinePath, 'utf8');
  const banner = /[ \t]*<!-- The play-money notice[\s\S]*?-->\s*<p class="demo"[\s\S]*?<\/p>\s*\n/;
  if (!banner.test(offline)) {
    throw new Error('offline.html: the demo banner is not where this script expects it');
  }
  writeFileSync(offlinePath, offline.replace(banner, ''));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] ?? fileURLToPath(new URL('../public', import.meta.url));
  makeLicensed(dir);
  console.warn(`licensed build: demo wording removed from the static files in ${dir}`);
}
