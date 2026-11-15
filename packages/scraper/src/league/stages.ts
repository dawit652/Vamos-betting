/**
 * League stages and classes of the league factory (docs/plans/hulusport-parity-plan.md 4.2 and
 * 4.3; tasks 3.5 and 3.6). Pure: the nightly job measures, these functions decide, and the job
 * writes the outcome (and its reasons) to the league's policy and the weekly report. No person is
 * asked; every threshold is a starting value to be tuned in shadow.
 *
 * Stages:
 *
 * | Stage           | Enters when                                                                 |
 * | --------------- | --------------------------------------------------------------------------- |
 * | 0 found         | bound on both providers                                                     |
 * | 1 shadow        | its sources are written (observed only, nothing listed)                     |
 * | 2 open_low      | 14 days in shadow; every club mapped; two sources agreed on the kickoff of  |
 * |                 | 98% of fixtures; a sharp consensus on 90%; 20 finished matches whose shadow |
 * |                 | result matched on every source                                              |
 * | 3 normal        | 4 weeks at stage 2; 40 settled matches; no wrong result; median closing-    |
 * |                 | line value ≥ 0; never a price above the best bookmaker                      |
 *
 * Back to shadow, from stage 2 or 3, on any of: a wrong result found by the audit, a sharp
 * consensus on under 70% of fixtures over the last week, a source of the league that lost its
 * trust. Demotion is checked before promotion, and a league climbs at most one stage a night.
 */

const DAY_MS = 86_400_000;

export const LEAGUE_STAGES = ['found', 'shadow', 'open_low', 'normal'] as const;
export type LeagueStage = (typeof LEAGUE_STAGES)[number];

/** Starting values of the gates (plan 4.3), tuned in shadow. */
export const STAGE_GATES = Object.freeze({
  shadowDays: 14,
  kickoffAgreement: 0.98,
  sharpConsensus: 0.9,
  shadowResultsMatched: 20,
  openLowDays: 28,
  settledMatches: 40,
  demoteSharpConsensus: 0.7,
});

/** A share measured over fixtures: `hits` of `total`. */
export interface Share {
  readonly hits: number;
  readonly total: number;
}

/** What the nightly job measured for one league. */
export interface LeagueMetrics {
  /** The league is bound on both providers (step 2 of the factory). */
  readonly bound: boolean;
  /** Its sources and policy rows are written. */
  readonly sourcesWritten: boolean;
  /** Clubs of the league whose spelling on every source is mapped. */
  readonly clubsMapped: Share;
  /** Fixtures whose kickoff two sources agreed on. */
  readonly kickoffAgreement: Share;
  /** Fixtures with a sharp consensus (rule O1m) since the league entered its stage. */
  readonly sharpConsensus: Share;
  /** The same over the last 7 days (the demotion rule). */
  readonly sharpConsensusLastWeek: Share;
  /** Finished matches whose shadow result matched on every source. */
  readonly shadowResultsMatched: number;
  /** Matches settled since the league entered stage 2. */
  readonly settledMatches: number;
  /** Wrong results the nightly audit found since the league entered its stage. */
  readonly wrongResults: number;
  /** Median closing-line value of our prices (null: not measured yet). */
  readonly medianClv: number | null;
  /** Prices of ours above the best bookmaker's since the league entered its stage. */
  readonly pricesAboveBest: number;
  /** A source of the league lost its trust (truth-check). */
  readonly sourceLostTrust: boolean;
}

export interface LeagueStageInput {
  readonly stage: LeagueStage;
  /** When the league entered its current stage. */
  readonly since: Date;
  readonly now: Date;
  readonly metrics: LeagueMetrics;
}

export interface LeagueStageDecision {
  readonly stage: LeagueStage;
  readonly changed: boolean;
  /** Why it moved (or, unchanged, which gates still fail), as stable codes for the report. */
  readonly reasons: readonly string[];
}

function shareAtLeast(share: Share, min: number): boolean {
  if (!Number.isSafeInteger(share.hits) || !Number.isSafeInteger(share.total)) return false;
  if (share.total <= 0 || share.hits < 0 || share.hits > share.total) return false;
  return share.hits / share.total >= min;
}

function shareBelow(share: Share, max: number): boolean {
  if (share.total <= 0) return false;
  return share.hits / share.total < max;
}

/**
 * The stage a league moves to tonight. Fails closed: a measurement that cannot be read fails its
 * gate, and unknown closing-line value or a price above the best bookmaker keep a league at
 * stage 2.
 */
export function nextLeagueStage(input: LeagueStageInput): LeagueStageDecision {
  const { stage, metrics: m } = input;
  const nowMs = input.now.getTime();
  const sinceMs = input.since.getTime();
  if (!Number.isFinite(nowMs) || !Number.isFinite(sinceMs)) {
    throw new RangeError('now and since must be valid dates');
  }
  const days = (nowMs - sinceMs) / DAY_MS;

  // Back to shadow first.
  if (stage === 'open_low' || stage === 'normal') {
    const down: string[] = [];
    if (m.wrongResults > 0) down.push('wrong_result');
    if (shareBelow(m.sharpConsensusLastWeek, STAGE_GATES.demoteSharpConsensus)) {
      down.push('sharp_consensus_below_70');
    }
    if (m.sourceLostTrust) down.push('source_lost_trust');
    if (!m.bound) down.push('binding_lost');
    if (down.length > 0) return { stage: 'shadow', changed: true, reasons: down };
  }

  const failing: string[] = [];
  const gate = (ok: boolean, code: string) => {
    if (!ok) failing.push(code);
  };
  switch (stage) {
    case 'found':
      gate(m.bound, 'not_bound');
      gate(m.sourcesWritten, 'sources_not_written');
      return failing.length === 0
        ? { stage: 'shadow', changed: true, reasons: ['sources_written'] }
        : { stage, changed: false, reasons: failing };
    case 'shadow':
      gate(m.bound, 'not_bound');
      gate(days >= STAGE_GATES.shadowDays, 'shadow_days');
      gate(
        m.clubsMapped.total > 0 && m.clubsMapped.hits === m.clubsMapped.total,
        'clubs_not_all_mapped',
      );
      gate(shareAtLeast(m.kickoffAgreement, STAGE_GATES.kickoffAgreement), 'kickoff_agreement');
      gate(shareAtLeast(m.sharpConsensus, STAGE_GATES.sharpConsensus), 'sharp_consensus');
      gate(m.shadowResultsMatched >= STAGE_GATES.shadowResultsMatched, 'shadow_results');
      gate(m.wrongResults === 0, 'wrong_result');
      gate(!m.sourceLostTrust, 'source_lost_trust');
      return failing.length === 0
        ? { stage: 'open_low', changed: true, reasons: ['gates_passed'] }
        : { stage, changed: false, reasons: failing };
    case 'open_low':
      gate(days >= STAGE_GATES.openLowDays, 'open_low_days');
      gate(m.settledMatches >= STAGE_GATES.settledMatches, 'settled_matches');
      gate(m.medianClv !== null && m.medianClv >= 0, 'closing_line_value');
      gate(m.pricesAboveBest === 0, 'price_above_best');
      return failing.length === 0
        ? { stage: 'normal', changed: true, reasons: ['gates_passed'] }
        : { stage, changed: false, reasons: failing };
    case 'normal':
      return { stage, changed: false, reasons: [] };
    default: {
      const unknown: never = stage;
      throw new RangeError(`unknown league stage: ${String(unknown)}`);
    }
  }
}

/** What each stage lets the league do (plan 4.3). */
export function stagePermissions(stage: LeagueStage): {
  listed: boolean;
  autoOpen: boolean;
  autoResults: boolean;
  /** Share of the normal limits. */
  limitShare: number;
} {
  switch (stage) {
    case 'found':
    case 'shadow':
      return { listed: false, autoOpen: false, autoResults: false, limitShare: 0 };
    case 'open_low':
      return { listed: true, autoOpen: true, autoResults: true, limitShare: 0.25 };
    case 'normal':
      return { listed: true, autoOpen: true, autoResults: true, limitShare: 1 };
    default: {
      const unknown: never = stage;
      throw new RangeError(`unknown league stage: ${String(unknown)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// League classes (plan 4.2, task 3.6)

export const LEAGUE_CLASSES = ['sharp', 'soft', 'none'] as const;
export type LeagueClass = (typeof LEAGUE_CLASSES)[number];

/** What the feeds delivered for a league over the measuring window. */
export interface LeagueClassEvidence {
  /**
   * Share of fixtures with at least three independent bookmakers, one of them Pinnacle or an
   * exchange (rule O1m), on the price layer.
   */
  readonly sharpFixtures: Share;
  /**
   * Share of fixtures with at least four independent bookmakers from the spine's odds, none
   * sharp, whose prices were stable over two reads.
   */
  readonly softFixtures: Share;
}

/** Starting values (plan 4.2), tuned in shadow. */
export const CLASS_GATES = Object.freeze({
  /** A league is sharp when this share of its fixtures has a sharp consensus. */
  sharpShare: 0.9,
  /** A league is soft when this share of its fixtures has a soft consensus. */
  softShare: 0.9,
});

/** Margin (bps), limit share and betting close lead per class (plan 4.2). */
export const CLASS_TERMS: Readonly<
  Record<
    LeagueClass,
    {
      minMarginBps: number;
      maxMarginBps: number;
      limitShare: number;
      closeLeadMinutes: number;
      markets: 'full' | 'tier_a' | 'none';
    }
  >
> = Object.freeze({
  sharp: {
    minMarginBps: 500,
    maxMarginBps: 700,
    limitShare: 1,
    closeLeadMinutes: 5,
    markets: 'full',
  },
  soft: {
    minMarginBps: 800,
    maxMarginBps: 1000,
    limitShare: 0.25,
    closeLeadMinutes: 60,
    markets: 'tier_a',
  },
  none: { minMarginBps: 0, maxMarginBps: 0, limitShare: 0, closeLeadMinutes: 0, markets: 'none' },
});

/**
 * The class of a league tonight. Class 2 ('soft') exists only when the owner decided D5 and
 * check 0.3 passed (`softAllowed`); otherwise a league without a sharp consensus is 'none': no
 * event in this plan is priced by our model alone.
 */
export function leagueClass(
  evidence: LeagueClassEvidence,
  options: { softAllowed: boolean },
): LeagueClass {
  if (shareAtLeast(evidence.sharpFixtures, CLASS_GATES.sharpShare)) return 'sharp';
  if (options.softAllowed && shareAtLeast(evidence.softFixtures, CLASS_GATES.softShare)) {
    return 'soft';
  }
  return 'none';
}
