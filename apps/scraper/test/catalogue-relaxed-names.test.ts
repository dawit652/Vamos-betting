import { buildAliasIndex, LEGAL_FORM_TOKENS, resolveTeam } from '@vamos/scraper';
import { describe, expect, it } from 'vitest';
import { CATALOG_TEAMS } from '../../../packages/db/src/seed/catalog';

/**
 * Rule N2b on the real catalogue (U-3): taking the legal form off never makes a catalogue team's
 * name resolve to ANOTHER team. Every football team's names, with every legal-form token added at
 * either end, resolve to that team or stay unknown (a relaxed name two teams share is not used).
 */
describe('N2b on the seeded catalogue', () => {
  const football = CATALOG_TEAMS.filter((t) => t.sport === 'football');
  const index = buildAliasIndex({
    teams: football.map((t) => ({
      id: t.shortName,
      sportId: 'football',
      shortName: t.shortName,
      names: Object.values(t.name).filter((n): n is string => typeof n === 'string'),
    })),
    teamAliases: [],
    competitions: [],
    competitionAliases: [],
  });

  it('a name with a legal form added resolves to its own team or not at all', () => {
    const wrong: string[] = [];
    let resolved = 0;
    for (const team of football) {
      const names = [team.shortName, team.name.en].filter((n): n is string => !!n);
      for (const name of names) {
        for (const token of LEGAL_FORM_TOKENS) {
          for (const raw of [`${name} ${token.toUpperCase()}`, `${token.toUpperCase()} ${name}`]) {
            const r = resolveTeam(index, { sportId: 'football', sourceId: 'src-x', raw });
            if (r.status !== 'resolved') continue;
            resolved += 1;
            if (r.id !== team.shortName)
              wrong.push(`${raw} -> ${r.id} (expected ${team.shortName})`);
          }
        }
      }
    }
    expect(wrong).toEqual([]);
    // The rule does resolve most of them (a guard against a vacuous pass).
    expect(resolved).toBeGreaterThan(football.length);
  });
});
