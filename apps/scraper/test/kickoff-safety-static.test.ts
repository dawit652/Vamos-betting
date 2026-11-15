import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * What keeps rule K1 inside the scraper rule of CLAUDE.md (docs/scraper-plan/kickoff-safety.md section 4):
 * the automatic kickoff code can write ONE column, `events.betting_open`, only to false. It cannot
 * result, void, cancel, move, re-price or open anything. These checks read the source text of the
 * module, so adding a capability to it fails here first and a person has to look.
 */

const SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../src/pipeline/kickoff-safety.ts'),
  'utf8',
);

/** Value imports allowed from @vamos/db (types are free). */
const DB_VALUES = ['getEventExposure', 'loadKickoffEvidence', 'lockEvent', 'setEventBettingOpen'];

/** Every module the K1 file may import from, with the values it may take (types are free). */
const ALLOWED_IMPORTS: Record<string, readonly string[] | '*'> = {
  '@vamos/core': ['SCRAPED_FEED_PROVIDER'],
  '@vamos/db': DB_VALUES,
  // Table definitions for READS (`select`): the write words are forbidden below.
  '@vamos/db/schema': ['betLegs', 'events'],
  '@vamos/scraper': [
    'assessKickoff',
    'earlierKickoffAction',
    'KICKOFF_EVIDENCE_WINDOW_MS',
    'MIN_MATCH_DURATION_MS',
    'SOURCE_STALE_AFTER_MS',
  ],
  'drizzle-orm': ['and', 'asc', 'eq', 'gt', 'isNull'],
  '../context': [],
  '../lib/publish': ['publishAfterCommit'],
  './common': ['auditScraper', 'openGateReviews', 'teamNames'],
};

const FORBIDDEN_WORDS = [
  'resultEvent',
  'voidMarket',
  'voidSelection',
  'setMarketStatus',
  'suspendEvent',
  'resumeEvent',
  'applyLiveState',
  'upsertFixture',
  'setSelectionOdds',
  // Every other way to move an event or its money.
  'applyResult',
  'settle',
  'cancelEvent',
  'postponeEvent',
  'setOdds',
  'placeBet',
  'openBetting',
];

interface Import {
  from: string;
  names: Array<{ name: string; isType: boolean }>;
}

function importsOf(source: string): Import[] {
  const out: Import[] = [];
  const statement = /import\s+(type\s+)?([^;]*?)\s+from\s+'([^']+)';/gs;
  for (const match of source.matchAll(statement)) {
    const [, whole, clause, from] = match as unknown as [
      string,
      string | undefined,
      string,
      string,
    ];
    const braces = /^\{([^}]*)\}$/s.exec(clause.trim());
    // A default or namespace import cannot be audited name by name: it is refused below.
    const names =
      braces === null
        ? [{ name: `<${clause.trim()}>`, isType: false }]
        : braces[1]!
            .split(',')
            .map((part) => part.trim())
            .filter((part) => part !== '')
            .map((part) => {
              const isType = whole !== undefined || part.startsWith('type ');
              return {
                name: part
                  .replace(/^type\s+/, '')
                  .split(/\s+as\s+/)[0]!
                  .trim(),
                isType,
              };
            });
    out.push({ from, names });
  }
  return out;
}

/** The arguments of every `fn(...)` call in the text, split at top-level commas. */
function callsOf(source: string, fn: string): string[][] {
  const calls: string[][] = [];
  let at = source.indexOf(`${fn}(`);
  while (at !== -1) {
    let depth = 0;
    let current = '';
    const args: string[] = [];
    for (let i = at + fn.length; i < source.length; i += 1) {
      const ch = source[i]!;
      if (ch === '(' || ch === '[' || ch === '{') {
        depth += 1;
        if (depth === 1) continue;
      } else if (ch === ')' || ch === ']' || ch === '}') {
        depth -= 1;
        if (depth === 0) {
          if (current.trim() !== '') args.push(current.trim());
          break;
        }
      } else if (ch === ',' && depth === 1) {
        args.push(current.trim());
        current = '';
        continue;
      }
      current += ch;
    }
    calls.push(args);
    at = source.indexOf(`${fn}(`, at + 1);
  }
  return calls;
}

describe('K1 stays inside the scraper rule (static)', () => {
  it('imports only what the allow-list names; from @vamos/db only the four reads/the one close', () => {
    const imports = importsOf(SOURCE);
    expect(imports.length).toBeGreaterThan(0);
    for (const entry of imports) {
      const allowed = ALLOWED_IMPORTS[entry.from];
      expect(allowed, `unexpected import from '${entry.from}'`).toBeDefined();
      for (const { name, isType } of entry.names) {
        if (isType) continue;
        expect(
          allowed === '*' || (allowed as readonly string[]).includes(name),
          `'${name}' from '${entry.from}' is not in the allow-list`,
        ).toBe(true);
      }
    }
    const db = imports.filter((entry) => entry.from === '@vamos/db');
    const taken = db.flatMap((entry) => entry.names.filter((n) => !n.isType).map((n) => n.name));
    expect(taken.sort()).toEqual([...DB_VALUES].sort());
    // No dynamic or CommonJS loading around the allow-list.
    expect(SOURCE).not.toMatch(/\brequire\s*\(/);
    expect(SOURCE).not.toMatch(/\bimport\s*\(/);
    expect(SOURCE).not.toMatch(/export\s+\*\s+from/);
  });

  it('contains no word of a result, void, cancel, price, status or move operation', () => {
    for (const word of FORBIDDEN_WORDS) {
      expect(SOURCE.includes(word), `the K1 module mentions ${word}`).toBe(false);
    }
  });

  it('writes nothing with drizzle directly: no .update(, .insert( or .delete(, no raw write SQL', () => {
    for (const write of ['.update(', '.insert(', '.delete(', '.onConflict', '.execute(']) {
      expect(SOURCE.includes(write), `the K1 module contains ${write}`).toBe(false);
    }
    expect(SOURCE).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b\s+(INTO|FROM|\w+\s+SET)/i);
    expect(SOURCE).not.toMatch(/sql`/);
  });

  it('every setEventBettingOpen call is (tx, eventId, false): the literal false, and no actor', () => {
    const calls = callsOf(SOURCE, 'setEventBettingOpen');
    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) {
      expect(args).toHaveLength(3);
      expect(args[2]).toBe('false');
    }
  });

  it('the helpers behind the checks work (they would otherwise pass on anything)', () => {
    expect(
      importsOf(`import { a, type B } from 'x';\nimport type { C } from 'y';\nimport d from 'z';`),
    ).toEqual([
      {
        from: 'x',
        names: [
          { name: 'a', isType: false },
          { name: 'B', isType: true },
        ],
      },
      { from: 'y', names: [{ name: 'C', isType: true }] },
      { from: 'z', names: [{ name: '<d>', isType: false }] },
    ]);
    expect(callsOf('f(tx, id, g(1, 2), false); f(tx, id, true)', 'f')).toEqual([
      ['tx', 'id', 'g(1, 2)', 'false'],
      ['tx', 'id', 'true'],
    ]);
  });
});
