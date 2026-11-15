import { normalizeName } from '../normalize/name';

/**
 * Team votes (docs/plans/hulusport-parity-plan.md 4.3 step 4; the pure core of the league factory's
 * name mapping, a sibling of rule N4). No I/O.
 *
 * For ONE bound competition and ONE source: pair the source's fixtures with the spine's by kickoff
 * (only when the pairing is unambiguous), let each pair give its unknown spellings one vote for the
 * club on their side, and decide. Everything fails closed: a mapping needs two different fixtures,
 * no vote for another club and no other spelling claiming the club; a vote against an active alias
 * suspends it. The caller does the I/O: writes the aliases (source-scoped, audited as N4 does),
 * closes betting on a suspended alias's club and drops that spelling's votes (`votes` already has).
 *
 * Spellings are compared in `normalizeName` form, which is also the form returned.
 */

export const DEFAULT_KICKOFF_TOLERANCE_MS = 5 * 60_000;
/** A spelling is mapped with votes from at least this many different fixtures. */
export const MIN_VOTE_FIXTURES = 2;

/** A fixture of the spine (API-Football). `key` is its fixture number. */
export interface SpineFixture {
  key: string;
  kickoff: Date;
  homeClubId: string;
  awayClubId: string;
}

/** A fixture of the source. `key` is its event id. */
export interface SourceFixture {
  key: string;
  kickoff: Date;
  home: string;
  away: string;
}

export interface SourceAlias {
  spelling: string;
  clubId: string;
  state: 'active' | 'suspended';
}

/** One vote: the spelling is the club, shown by one paired fixture (its key is the vote's identity). */
export interface TeamVote {
  spelling: string;
  clubId: string;
  spineFixtureKey: string;
  sourceEventKey: string;
  kickoff: Date;
}

/** What an audit row cites. */
export interface TeamVoteEvidence {
  spineFixtureKey: string | null;
  sourceEventKey: string;
  kickoff: Date;
}

export type UndecidedReason = 'one_vote' | 'conflicting_votes' | 'club_claimed_by_other_spelling';

export type UnlistedReason =
  | 'no_spine_fixture_in_window'
  | 'ambiguous_pairing'
  | 'flipped_orientation'
  | 'inconsistent_known_pair'
  | 'known_club_not_in_window'
  | 'duplicate_event'
  | 'no_unique_elimination'
  | 'alias_contradicted';

export interface TeamVoteMapping {
  spelling: string;
  clubId: string;
  evidence: TeamVoteEvidence[];
}

export interface TeamVoteUndecided {
  spelling: string;
  reason: UndecidedReason;
  clubIds: string[];
  evidence: TeamVoteEvidence[];
}

export interface TeamVoteSuspension {
  spelling: string;
  clubId: string;
  reason: 'vote_against_alias';
  evidence: TeamVoteEvidence[];
}

export interface TeamVoteUnlisted {
  sourceEventKey: string;
  kickoff: Date;
  home: string;
  away: string;
  reason: UnlistedReason;
}

export interface TeamVotesInput {
  spine: readonly SpineFixture[];
  source: readonly SourceFixture[];
  aliases: readonly SourceAlias[];
  /** Votes kept from earlier runs. */
  previousVotes?: readonly TeamVote[];
  toleranceMs?: number;
}

export interface TeamVotesResult {
  mappings: TeamVoteMapping[];
  undecided: TeamVoteUndecided[];
  suspensions: TeamVoteSuspension[];
  unlisted: TeamVoteUnlisted[];
  /** Source events explained or paired this run (for the audit trail). */
  paired: { sourceEventKey: string; spineFixtureKey: string }[];
  /** Previous votes plus this run's, deduplicated by (spelling, spine fixture); suspended spellings restart. */
  votes: TeamVote[];
}

interface NormSource {
  fx: SourceFixture;
  home: string;
  away: string;
  t: number;
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function decideTeamVotes(input: TeamVotesInput): TeamVotesResult {
  const tol = input.toleranceMs ?? DEFAULT_KICKOFF_TOLERANCE_MS;
  const active = new Map<string, string>();
  for (const a of input.aliases) {
    if (a.state === 'active') active.set(normalizeName(a.spelling), a.clubId);
  }
  const spine = [...input.spine].sort((a, b) => byText(a.key, b.key));
  const sources: NormSource[] = [...input.source]
    .sort((a, b) => byText(a.key, b.key))
    .map((fx) => ({
      fx,
      home: normalizeName(fx.home),
      away: normalizeName(fx.away),
      t: fx.kickoff.getTime(),
    }));
  const near = (s: NormSource): SpineFixture[] =>
    spine.filter((f) => Math.abs(f.kickoff.getTime() - s.t) <= tol);

  const newVotes: TeamVote[] = [];
  const paired = new Map<string, string>(); // source key -> spine key
  const pairedSpine = new Set<string>();
  const unlisted = new Map<string, UnlistedReason>();
  const against = new Map<string, { clubId: string; evidence: TeamVoteEvidence[] }>();

  const pair = (s: NormSource, f: SpineFixture): void => {
    paired.set(s.fx.key, f.key);
    pairedSpine.add(f.key);
  };
  const vote = (s: NormSource, f: SpineFixture, spelling: string, clubId: string): void => {
    newVotes.push({
      spelling,
      clubId,
      spineFixtureKey: f.key,
      sourceEventKey: s.fx.key,
      kickoff: f.kickoff,
    });
  };
  const addAgainst = (spelling: string, clubId: string, s: NormSource, f: SpineFixture[]): void => {
    const entry = against.get(spelling) ?? { clubId, evidence: [] };
    entry.evidence.push({
      spineFixtureKey: f.map((x) => x.key).join(',') || null,
      sourceEventKey: s.fx.key,
      kickoff: s.fx.kickoff,
    });
    against.set(spelling, entry);
  };

  // Rules 1 and 2: fixtures with at least one active alias.
  for (const s of sources) {
    const hc = active.get(s.home);
    const ac = active.get(s.away);
    if (hc === undefined && ac === undefined) continue;
    const window = near(s);
    if (window.length === 0) {
      unlisted.set(s.fx.key, 'no_spine_fixture_in_window');
      continue;
    }
    if (hc !== undefined && ac !== undefined) {
      const exact = window.filter((f) => f.homeClubId === hc && f.awayClubId === ac);
      const first = exact[0];
      if (first !== undefined) {
        pair(s, first);
        continue;
      }
      const appears = (club: string): boolean =>
        window.some((f) => f.homeClubId === club || f.awayClubId === club);
      const homeGone = !appears(hc);
      const awayGone = !appears(ac);
      if (homeGone) addAgainst(s.home, hc, s, window);
      if (awayGone) addAgainst(s.away, ac, s, window);
      unlisted.set(
        s.fx.key,
        homeGone || awayGone
          ? 'alias_contradicted'
          : window.some((f) => f.homeClubId === ac && f.awayClubId === hc)
            ? 'flipped_orientation'
            : 'inconsistent_known_pair',
      );
      continue;
    }
    // exactly one side known
    const knownHome = hc !== undefined;
    const club = (knownHome ? hc : ac) as string;
    const same = window.filter((f) => (knownHome ? f.homeClubId : f.awayClubId) === club);
    const first = same[0];
    if (same.length > 1 || first === undefined) {
      const flipped = window.some((f) => (knownHome ? f.awayClubId : f.homeClubId) === club);
      unlisted.set(
        s.fx.key,
        same.length > 1
          ? 'ambiguous_pairing'
          : flipped
            ? 'flipped_orientation'
            : 'known_club_not_in_window',
      );
      continue;
    }
    pair(s, first);
    if (knownHome) vote(s, first, s.away, first.awayClubId);
    else vote(s, first, s.home, first.homeClubId);
  }

  // Duplicates of an already paired event (same spellings, same kickoff window) are no new evidence.
  const sig = (s: NormSource): string => `${s.home}\u0000${s.away}`;
  const pairedSigs = sources.filter((s) => paired.has(s.fx.key));
  const isDuplicate = (s: NormSource): boolean =>
    pairedSigs.some((p) => sig(p) === sig(s) && Math.abs(p.t - s.t) <= tol);

  // Rule 3: elimination among fixtures with no known side, iterated.
  let progress = true;
  while (progress) {
    progress = false;
    const remainingSpine = spine.filter((f) => !pairedSpine.has(f.key));
    // Unpaired fixtures with a known side stay in: they may be the match of a remaining spine fixture.
    const remainingSources = sources.filter(
      (s) => !paired.has(s.fx.key) && unlisted.get(s.fx.key) !== 'duplicate_event',
    );
    for (const s of remainingSources) {
      if (active.has(s.home) || active.has(s.away)) continue;
      const cands = remainingSpine.filter((f) => Math.abs(f.kickoff.getTime() - s.t) <= tol);
      const only = cands[0];
      if (cands.length !== 1 || only === undefined) continue;
      const rivals = remainingSources.filter((o) => Math.abs(o.t - only.kickoff.getTime()) <= tol);
      if (rivals.length !== 1) continue;
      if (isDuplicate(s)) {
        unlisted.set(s.fx.key, 'duplicate_event');
        progress = true;
        break;
      }
      pair(s, only);
      vote(s, only, s.home, only.homeClubId);
      vote(s, only, s.away, only.awayClubId);
      progress = true;
      break;
    }
  }
  for (const s of sources) {
    if (paired.has(s.fx.key) || unlisted.has(s.fx.key)) continue;
    unlisted.set(
      s.fx.key,
      near(s).length === 0 ? 'no_spine_fixture_in_window' : 'no_unique_elimination',
    );
  }

  // Suspensions restart the spelling's votes.
  const suspensions: TeamVoteSuspension[] = [...against.entries()]
    .sort(([a], [b]) => byText(a, b))
    .map(([spelling, e]) => ({
      spelling,
      clubId: e.clubId,
      reason: 'vote_against_alias' as const,
      evidence: e.evidence,
    }));
  const suspended = new Set(suspensions.map((s) => s.spelling));

  // Accumulate votes: only spellings without an active alias take part.
  const allVotes = new Map<string, TeamVote>();
  for (const v of [...(input.previousVotes ?? []), ...newVotes]) {
    const spelling = normalizeName(v.spelling);
    if (active.has(spelling) || suspended.has(spelling)) continue;
    const key = `${spelling}\u0000${v.spineFixtureKey}`;
    if (!allVotes.has(key)) allVotes.set(key, { ...v, spelling });
  }
  const votes = [...allVotes.values()];

  // Decisions.
  const bySpelling = new Map<string, Map<string, TeamVote[]>>();
  for (const v of votes) {
    const clubs = bySpelling.get(v.spelling) ?? new Map<string, TeamVote[]>();
    clubs.set(v.clubId, [...(clubs.get(v.clubId) ?? []), v]);
    bySpelling.set(v.spelling, clubs);
  }
  const evidenceOf = (vs: TeamVote[]): TeamVoteEvidence[] =>
    vs.map((v) => ({
      spineFixtureKey: v.spineFixtureKey,
      sourceEventKey: v.sourceEventKey,
      kickoff: v.kickoff,
    }));
  const claimants = new Map<string, Set<string>>(); // club -> spellings voting for it
  for (const [spelling, clubs] of bySpelling) {
    for (const club of clubs.keys()) {
      const set = claimants.get(club) ?? new Set<string>();
      set.add(spelling);
      claimants.set(club, set);
    }
  }
  const activeClubs = new Set(active.values());

  const mappings: TeamVoteMapping[] = [];
  const undecided: TeamVoteUndecided[] = [];
  for (const spelling of [...bySpelling.keys()].sort(byText)) {
    const clubs = bySpelling.get(spelling) as Map<string, TeamVote[]>;
    const clubIds = [...clubs.keys()].sort(byText);
    const all = [...clubs.values()].flat();
    const decline = (reason: UndecidedReason): void => {
      undecided.push({ spelling, reason, clubIds, evidence: evidenceOf(all) });
    };
    const clubId = clubIds[0];
    if (clubId === undefined) continue;
    if (clubIds.length > 1) {
      decline('conflicting_votes');
      continue;
    }
    const mine = clubs.get(clubId) as TeamVote[];
    if (mine.length < MIN_VOTE_FIXTURES) {
      decline('one_vote');
      continue;
    }
    if (activeClubs.has(clubId) || (claimants.get(clubId)?.size ?? 0) > 1) {
      decline('club_claimed_by_other_spelling');
      continue;
    }
    mappings.push({ spelling, clubId, evidence: evidenceOf(mine) });
  }

  return {
    mappings,
    undecided,
    suspensions,
    unlisted: sources
      .filter((s) => unlisted.has(s.fx.key))
      .map((s) => ({
        sourceEventKey: s.fx.key,
        kickoff: s.fx.kickoff,
        home: s.home,
        away: s.away,
        reason: unlisted.get(s.fx.key) as UnlistedReason,
      })),
    paired: [...paired.entries()].map(([sourceEventKey, spineFixtureKey]) => ({
      sourceEventKey,
      spineFixtureKey,
    })),
    votes,
  };
}
