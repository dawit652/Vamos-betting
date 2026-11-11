import type { RatingRow } from '@vamos/contracts';

/** Pure helpers for the ratings page (plan R-3). */

export interface RatingsFormInput {
  attack: string;
  defence: string;
  /** Empty = keep what the team has. */
  matches: string;
}

export interface RatingsBody {
  attack: number;
  defence: number;
  matches?: number;
}

/** A strict decimal number: no empty text, no "1abc", no NaN or Infinity. */
export function parseDecimal(text: string): number | null {
  const t = text.trim();
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(t)) return null;
  const value = Number(t);
  return Number.isFinite(value) ? value : null;
}

/** The request a form becomes, or the first problem (the same bounds the API enforces). */
export function validateRatingsForm(
  input: RatingsFormInput,
  band: { min: number; max: number },
  maxMatches = 10_000,
): { ok: true; body: RatingsBody } | { ok: false; error: string } {
  const attack = parseDecimal(input.attack);
  const defence = parseDecimal(input.defence);
  if (attack === null) return { ok: false, error: 'Attack must be a number.' };
  if (defence === null) return { ok: false, error: 'Defence must be a number.' };
  for (const [label, value] of [
    ['Attack', attack],
    ['Defence', defence],
  ] as const) {
    if (value < band.min || value > band.max) {
      return {
        ok: false,
        error: `${label} must be between ${band.min} and ${band.max} (1 is the league average).`,
      };
    }
  }
  const body: RatingsBody = { attack, defence };
  if (input.matches.trim() !== '') {
    const matches = parseDecimal(input.matches);
    if (matches === null || !Number.isInteger(matches) || matches < 0 || matches > maxMatches) {
      return { ok: false, error: `Matches must be a whole number from 0 to ${maxMatches}.` };
    }
    body.matches = matches;
  }
  return { ok: true, body };
}

const num = (v: number | null): string => (v === null ? '-' : v.toFixed(3));

/** "attack 1.200, defence 0.900, 12 matches" ("no ratings" for a team without). */
export function ratingsText(row: Pick<RatingRow, 'attack' | 'defence' | 'matches'>): string {
  if (row.attack === null && row.defence === null && row.matches === 0) return 'no ratings';
  return `attack ${num(row.attack)}, defence ${num(row.defence)}, ${row.matches} matches`;
}

/** The sentence the confirmation step shows before a manual rating is saved. */
export function confirmRatingsText(
  row: Pick<RatingRow, 'team' | 'attack' | 'defence' | 'matches' | 'manual'>,
  body: RatingsBody,
): string {
  const after = {
    attack: body.attack,
    defence: body.defence,
    matches: body.matches ?? row.matches,
  };
  return (
    `Set ${row.team} by hand? Now: ${ratingsText(row)}${row.manual ? ' (manual)' : ''}. ` +
    `After: ${ratingsText(after)} (manual). A hand-set team counts as calibrated, so its matches ` +
    `may open on the model; the new ratings change its prices.`
  );
}

/** The query of the list: only the filled filters. */
export function ratingsQuery(team: string, unrated: boolean): Record<string, string> {
  const query: Record<string, string> = {};
  if (team.trim() !== '') query.team = team.trim();
  if (unrated) query.unrated = 'true';
  return query;
}

/**
 * The server command that backfills ratings from a results file. The page never uploads a file:
 * an operator runs this on the server (docs/scraper-operations.md), first with --dry-run.
 */
export function backfillCommand(competitionSlug: string): string {
  const slug = competitionSlug.trim() === '' ? '<competition-slug>' : competitionSlug.trim();
  return (
    'docker compose run --rm --no-deps -v "$PWD/results.json:/in/results.json:ro" scraper ' +
    `node dist/cli.js ratings backfill --file /in/results.json --competition ${slug} --dry-run`
  );
}
