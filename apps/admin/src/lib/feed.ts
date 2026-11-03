import type { FeedLeagueView } from '@vamos/contracts';

/** Highest league margin the API accepts, in basis points. */
export const MAX_MARGIN_BPS = 3000;

/** Basis points as a percent string for the input: 650 → "6.5", null → "" (the default). */
export function marginToInput(bps: number | null): string {
  if (bps === null) return '';
  const whole = Math.floor(bps / 100);
  const frac = String(bps % 100)
    .padStart(2, '0')
    .replace(/0$/, '');
  return frac === '0' || frac === '' ? String(whole) : `${whole}.${frac}`;
}

/**
 * A margin typed as a percent ("6.5") as basis points (650): blank is `null` (the default);
 * `undefined` is not a margin (not a number, more than two decimals, or above 30%). No floating point.
 */
export function parseMarginInput(input: string): number | null | undefined {
  const text = input.trim().replace(',', '.');
  if (text === '') return null;
  const match = /^(\d{1,2})(?:\.(\d{1,2}))?$/.exec(text);
  if (match === null) return undefined;
  const bps = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0') || '0');
  return bps <= MAX_MARGIN_BPS ? bps : undefined;
}

/** The leagues grouped by sport, sports and leagues in the order given. */
export function groupBySport(leagues: readonly FeedLeagueView[]): [string, FeedLeagueView[]][] {
  const groups = new Map<string, FeedLeagueView[]>();
  for (const league of leagues) {
    const list = groups.get(league.sportId) ?? [];
    list.push(league);
    groups.set(league.sportId, list);
  }
  return [...groups];
}
