import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The scale-out overlay (infra/docker-compose.scale.yml) puts PgBouncer in transaction-pooling mode
 * in front of the API. In that mode two requests can use the same server connection one after the
 * other, so anything that lives in a database SESSION is lost or leaks to someone else: session
 * advisory locks, LISTEN, session-level SET, temporary tables, cursors held past a transaction.
 * The API and the code it shares (packages/db, packages/core) use none of these today; the whole
 * database and API test suites pass through PgBouncer. This keeps it so. A transaction-level lock
 * (pg_advisory_xact_lock), SET LOCAL and set_config(..., true) are fine.
 *
 * The worker, the scraper and the migrate job keep their own direct connections and may use them.
 */
const ROOT = join(__dirname, '..', '..', '..');
const SCANNED = ['apps/api/src', 'packages/db/src', 'packages/core/src', 'packages/payments/src'];

const FORBIDDEN: { name: string; pattern: RegExp }[] = [
  { name: 'session advisory lock', pattern: /pg_(try_)?advisory_lock(_shared)?\s*\(/i },
  { name: 'session advisory unlock', pattern: /pg_advisory_unlock(_all|_shared)?\s*\(/i },
  { name: 'LISTEN / UNLISTEN', pattern: /['"`]\s*(UN)?LISTEN\s+\w/i },
  { name: 'NOTIFY channel', pattern: /['"`]\s*NOTIFY\s+\w/i },
  {
    name: 'session-level SET',
    // SQL only: an uppercase SET at the start of a string, or SET inside sql`...`; message texts that
    // happen to start with "set" do not count.
    pattern:
      /(?:['"`]\s*SET|sql`\s*(?:SET|set))\s+(?:SESSION\s+)?(?!LOCAL\b|local\b)[A-Za-z_.]+\s*(?:=|TO\b|to\b)/,
  },
  { name: 'temporary table', pattern: /\bCREATE\s+(GLOBAL\s+|LOCAL\s+)?TEMP(ORARY)?\s+TABLE\b/i },
  { name: 'cursor held past the transaction', pattern: /\bWITH\s+HOLD\b/i },
  { name: 'named prepared statement', pattern: /\bPREPARE\s+\w+\s+(AS|\()/i },
  { name: 'set_config for the session', pattern: /set_config\([^)]*,\s*false\s*\)/i },
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    // The ops scripts (migrate, seed, admin tools) are standalone tools on their own direct connection.
    if (statSync(path).isDirectory()) {
      return ['node_modules', 'scripts', 'ops'].includes(name) ? [] : sourceFiles(path);
    }
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('code that runs behind PgBouncer in transaction mode', () => {
  const files = SCANNED.flatMap((dir) => sourceFiles(join(ROOT, dir)));

  it('scans the source of the API and what it shares', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  for (const { name, pattern } of FORBIDDEN) {
    it(`uses no ${name}`, () => {
      const hits = files.flatMap((file) =>
        readFileSync(file, 'utf8')
          .split('\n')
          .flatMap((line, index) =>
            // Comments may talk about these things.
            !/^\s*(\/\/|\*|\/\*)/.test(line) && pattern.test(line)
              ? [`${relative(ROOT, file)}:${index + 1}: ${line.trim()}`]
              : [],
          ),
      );
      expect(hits).toEqual([]);
    });
  }
});
