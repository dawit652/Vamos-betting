import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const WEB_DIR = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = join(WEB_DIR, 'scripts', 'licensed-static.mjs');

describe('scripts/licensed-static.mjs (the licensed build of the static files)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'licensed-static-'));
    for (const name of ['manifest.webmanifest', 'offline.html']) {
      copyFileSync(join(WEB_DIR, 'public', name), join(dir, name));
    }
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = () => execFileSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' });

  it('starts from files that carry the demo wording (so the rewrite is what removes it)', () => {
    expect(readFileSync(join(dir, 'manifest.webmanifest'), 'utf8')).toMatch(/demo/i);
    expect(readFileSync(join(dir, 'offline.html'), 'utf8')).toMatch(/play money only/i);
  });

  it('removes the demo wording from the manifest and the offline page, keeping the rest', () => {
    run();
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.webmanifest'), 'utf8'));
    expect(manifest.name).toBe('Nahubet – sports betting');
    expect(manifest.description).not.toMatch(/demo|play money/i);
    expect(manifest.start_url).toBe('/?source=pwa');
    expect(manifest.icons).toHaveLength(4);
    const offline = readFileSync(join(dir, 'offline.html'), 'utf8');
    // Visible wording only: the `.demo` style rule left in the stylesheet shows nothing.
    expect(offline).not.toMatch(/play money|DEMO –|<p class="demo"/i);
    expect(offline).toContain('No connection. Check your internet and try again.');
    expect(offline).toContain('<main>');
  });

  it('throws instead of silently leaving the wording when a file changed shape', () => {
    writeFileSync(join(dir, 'offline.html'), '<html><body>no banner here</body></html>');
    expect(() => run()).toThrow(/offline\.html/);
  });
});
