/**
 * The stable key of a scraped event (docs/scraper.md section 4):
 * `fx|competitionId|homeTeamId|awayTeamId|YYYY-MM-DD` of the FIRST kickoff,
 * in UTC. It is stored as `events.feed_ref` and never changes, not even when
 * the match is rescheduled (rule F3 finds the event by other means).
 */
export interface FixtureKeyInput {
  competitionId: string;
  homeTeamId: string;
  awayTeamId: string;
  firstKickoff: Date;
}

export function fixtureKey(input: FixtureKeyInput): string {
  const { competitionId, homeTeamId, awayTeamId, firstKickoff } = input;
  for (const [label, part] of [
    ['competitionId', competitionId],
    ['homeTeamId', homeTeamId],
    ['awayTeamId', awayTeamId],
  ] as const) {
    // '|' is the separator: allowing it would let two different fixtures share a key.
    if (typeof part !== 'string' || part === '' || part.includes('|')) {
      throw new RangeError(`fixtureKey: ${label} must be a non-empty string without "|"`);
    }
  }
  if (!(firstKickoff instanceof Date) || Number.isNaN(firstKickoff.getTime())) {
    throw new RangeError('fixtureKey: firstKickoff is not a valid date');
  }
  // toISOString is always UTC; years beyond 9999 would print as +YYYYYY.
  const day = firstKickoff.toISOString();
  if (!/^\d{4}-/.test(day)) throw new RangeError('fixtureKey: firstKickoff out of range');
  return `fx|${competitionId}|${homeTeamId}|${awayTeamId}|${day.slice(0, 10)}`;
}
