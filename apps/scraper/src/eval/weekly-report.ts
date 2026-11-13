import type { TrustLevel } from '@vamos/scraper';
import type { ShadowSummaryRow } from './ladder-shadow';
import { TARGET_MEDIAN_MINUTES } from './result-audit';

/**
 * The weekly report (plan task 1.3, docs/plans/hulusport-parity-plan.md section 8): one row per
 * measure of "How we will know it matches Hulusport" that the scraper's data can answer, each with
 * its target and a pass, fail or unknown mark. Pure: the numbers come in, a document comes out.
 * A measure the data cannot answer is "unknown" with the reason, never a guess.
 */

const DAY_MS = 86_400_000;

// ------------------------------------------------------------------ weeks

/** An ISO week: Monday 00:00 UTC up to the next Monday (`to` is exclusive). */
export interface WeekWindow {
  /** As `YYYY-Www`. */
  id: string;
  from: Date;
  to: Date;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** The Monday 00:00 UTC of the ISO week that contains the instant. */
function mondayOf(at: Date): Date {
  const day = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  return new Date(day.getTime() - ((day.getUTCDay() + 6) % 7) * DAY_MS);
}

/** The ISO week (`YYYY-Www`) that contains the instant. */
export function isoWeekId(at: Date): string {
  const monday = mondayOf(at);
  // The ISO year is the year of the week's Thursday.
  const year = new Date(monday.getTime() + 3 * DAY_MS).getUTCFullYear();
  const week1 = mondayOf(new Date(Date.UTC(year, 0, 4)));
  const week = 1 + Math.round((monday.getTime() - week1.getTime()) / (7 * DAY_MS));
  return `${year}-W${pad2(week)}`;
}

/** The window of `YYYY-Www`; null when the text is not an ISO week. */
export function parseWeekId(text: string): WeekWindow | null {
  const m = /^(\d{4})-W(\d{2})$/.exec(text);
  if (m === null) return null;
  const year = Number(m[1]);
  const week = Number(m[2]);
  if (week < 1 || week > 53) return null;
  const week1 = mondayOf(new Date(Date.UTC(year, 0, 4)));
  const from = new Date(week1.getTime() + (week - 1) * 7 * DAY_MS);
  // Week 53 of a 52-week year is the next year's week 1: reject it.
  if (isoWeekId(from) !== text) return null;
  return { id: text, from, to: new Date(from.getTime() + 7 * DAY_MS) };
}

/** The most recent ISO week that has ended by `now`. */
export function lastCompleteWeek(now: Date): WeekWindow {
  const thisMonday = mondayOf(now);
  const window = parseWeekId(isoWeekId(new Date(thisMonday.getTime() - DAY_MS)));
  /* v8 ignore next */
  if (window === null) throw new Error('unreachable: a Sunday has an ISO week');
  return window;
}

// ------------------------------------------------------------------ inputs

/** What the gatherer measured for one week; every field is a plain number or list. */
export interface WeeklyInputs {
  week: WeekWindow;
  generatedAt: Date;
  catalogue: {
    /** Football competitions with at least one match kicking off in the week. */
    competitionsWithMatches: number;
    /** Football matches kicking off in the week that were not cancelled, abandoned or postponed. */
    matchesListed: number;
  };
  options: {
    /** Competitions whose policy prices the factory markets (`factory_markets` on). */
    factoryCompetitions: number;
    /** Matches of those competitions in the week. */
    matches: number;
    /** Median number of selections (options) per such match; null without matches. */
    typicalPerMatch: number | null;
  };
  /** Open review items now (a snapshot: the queue has no history). */
  reviewOpen: number;
  settlement: {
    /** Matches of the week that finished with a score. */
    finished: number;
    /** Of those, results applied by the result gate (rung A: a `scrape.result.applied` audit row). */
    onRungA: number;
    /** Matches of the week whose kickoff was at least 48 hours before the report. */
    due48h: number;
    /** Of those, settled (finished with a result by kickoff + 48 h) or void. */
    settledOrVoid48h: number;
  };
  /** The result audit of results applied in the week and at least 48 hours ago. */
  audit: {
    count: number;
    /** Results where at least one source disagrees. */
    mismatches: number;
    medianLatencyMinutes: number | null;
  };
  scorecard: {
    /** Events with captured closing prices. */
    events: number;
    /** Matches scored on 1X2 against Pinnacle. */
    oneXTwoPinnacleN: number;
    /** mean(our log-loss) / mean(Pinnacle's) - 1; null without a Pinnacle comparison. */
    relLogLossVsPinnacle: number | null;
    /** Selections priced, and the share above the best price of every book. */
    bestPriceN: number;
    bestPriceShareAbove: number | null;
  };
  trust: {
    upstream: string;
    compared: number;
    agreed: number;
    trust: TrustLevel;
  }[];
  /** Ladder-shadow decisions first made in the week, per rung and reason. */
  shadow: ShadowSummaryRow[];
}

// ------------------------------------------------------------------ output

export type Mark = 'pass' | 'fail' | 'unknown';

export interface MeasureRow {
  /** Stable key, for the JSON. */
  id: string;
  measure: string;
  /** The plan's target, as it is written there. */
  target: string;
  /** The measured value as text; null for an unknown. */
  value: string | null;
  mark: Mark;
  /** The numbers behind the mark, or the reason for an unknown. */
  note: string;
}

export interface WeeklyReport {
  markdown: string;
  json: WeeklyReportJson;
}

export interface WeeklyReportJson {
  week: { id: string; from: string; to: string };
  generatedAt: string;
  summary: { pass: number; fail: number; unknown: number };
  measures: MeasureRow[];
}

/** Section 8's targets, as numbers. */
export const WEEKLY_TARGETS = {
  competitions: 67,
  matchesListed: 800,
  optionsPerMatch: 500,
  rungAShare: 0.95,
  settledOrVoid48h: 1,
  /** Fewer than 1 in 2,000 matches. */
  wrongRate: 1 / 2000,
  /** Within 1% of Pinnacle's close. */
  pinnacleLogLoss: 0.01,
} as const;

const pct = (x: number, digits = 1): string => `${(100 * x).toFixed(digits)}%`;
const ofCount = (n: number, total: number): string => `${n} of ${total}`;
const mark = (ok: boolean): Mark => (ok ? 'pass' : 'fail');

function unknown(id: string, measure: string, target: string, reason: string): MeasureRow {
  return { id, measure, target, value: null, mark: 'unknown', note: reason };
}

/** The rows, in the order of section 8. */
export function weeklyMeasures(input: WeeklyInputs): MeasureRow[] {
  const rows: MeasureRow[] = [];
  const { catalogue, options, settlement, audit, scorecard } = input;

  rows.push({
    id: 'competitions',
    measure: 'Football competitions with matches',
    target: '67 sharp',
    value: String(catalogue.competitionsWithMatches),
    mark: mark(catalogue.competitionsWithMatches >= WEEKLY_TARGETS.competitions),
    note: 'competitions with a match kicking off in the week',
  });
  rows.push({
    id: 'matches_listed',
    measure: 'Football matches listed',
    target: '800 to 1,000 in season',
    value: String(catalogue.matchesListed),
    mark: mark(catalogue.matchesListed >= WEEKLY_TARGETS.matchesListed),
    note: 'matches kicking off in the week, not void; a week out of season reads low',
  });

  if (options.factoryCompetitions === 0) {
    rows.push(
      unknown(
        'options_typical',
        'Options, typical football match',
        '500 or more from scores; 540 or more with quarter lines',
        'no competition has factory markets switched on, so the catalogue holds only the basic markets',
      ),
    );
  } else if (options.typicalPerMatch === null) {
    rows.push(
      unknown(
        'options_typical',
        'Options, typical football match',
        '500 or more from scores; 540 or more with quarter lines',
        `${options.factoryCompetitions} competition(s) price factory markets, but none had a match in the week`,
      ),
    );
  } else {
    rows.push({
      id: 'options_typical',
      measure: 'Options, typical football match',
      target: '500 or more from scores; 540 or more with quarter lines',
      value: String(options.typicalPerMatch),
      mark: mark(options.typicalPerMatch >= WEEKLY_TARGETS.optionsPerMatch),
      note: `median selections per match over ${options.matches} match(es) of the factory competitions`,
    });
  }
  rows.push(
    unknown(
      'options_top',
      'Options, top match',
      '700 with Tiers B and C',
      'Tiers B and C are not built; the report reads only the typical match',
    ),
  );
  rows.push(
    unknown(
      'price_age',
      'Price age near kickoff',
      'Under 10 minutes on the 59 USD plan; under 5 after step 3',
      'the database keeps no price age; it is read from the feed page',
    ),
  );

  if (scorecard.oneXTwoPinnacleN === 0 || scorecard.relLogLossVsPinnacle === null) {
    rows.push(
      unknown(
        'pinnacle_1x2',
        "Our 1X2 against Pinnacle's close",
        'Within 1%',
        scorecard.events === 0
          ? 'no closing prices were captured in the week'
          : 'no settled match with a Pinnacle price in the week',
      ),
    );
  } else {
    const rel = scorecard.relLogLossVsPinnacle;
    rows.push({
      id: 'pinnacle_1x2',
      measure: "Our 1X2 against Pinnacle's close",
      target: 'Within 1%',
      value: `${rel >= 0 ? '+' : ''}${pct(rel)}`,
      mark: mark(rel <= WEEKLY_TARGETS.pinnacleLogLoss),
      note: `log-loss against Pinnacle's, ${scorecard.oneXTwoPinnacleN} match(es), from eval scorecard`,
    });
  }
  if (scorecard.bestPriceN === 0 || scorecard.bestPriceShareAbove === null) {
    rows.push(
      unknown(
        'price_above_best',
        'Price above the best bookmaker',
        'Never',
        'no selection had a best bookmaker price to compare with in the week',
      ),
    );
  } else {
    const above = Math.round(scorecard.bestPriceShareAbove * scorecard.bestPriceN);
    rows.push({
      id: 'price_above_best',
      measure: 'Price above the best bookmaker',
      target: 'Never',
      value: ofCount(above, scorecard.bestPriceN),
      mark: mark(above === 0),
      note: 'selections priced above the best price of every book, from eval scorecard',
    });
  }

  rows.push({
    id: 'review_waiting',
    measure: 'Review items waiting for a person',
    target: '0',
    value: String(input.reviewOpen),
    mark: mark(input.reviewOpen === 0),
    note: 'open now, when the report was made (the queue keeps no history)',
  });

  if (settlement.finished === 0) {
    rows.push(
      unknown(
        'rung_a_share',
        'Matches settled on rung A',
        '95%',
        'no match of the week finished with a score',
      ),
    );
  } else {
    const share = settlement.onRungA / settlement.finished;
    rows.push({
      id: 'rung_a_share',
      measure: 'Matches settled on rung A',
      target: '95%',
      value: pct(share),
      mark: mark(share >= WEEKLY_TARGETS.rungAShare),
      note: `${ofCount(settlement.onRungA, settlement.finished)} finished matches were applied by the result gate; the rest were entered by hand`,
    });
  }

  if (audit.medianLatencyMinutes === null) {
    rows.push(
      unknown(
        'whistle_to_settled',
        'Whistle to settled, rung A',
        'Median 20 minutes',
        'no result of the week was applied at least 48 hours ago, so the result audit has none to read',
      ),
    );
  } else {
    rows.push({
      id: 'whistle_to_settled',
      measure: 'Whistle to settled, rung A',
      target: 'Median 20 minutes',
      value: `${audit.medianLatencyMinutes.toFixed(1)} min`,
      mark: mark(audit.medianLatencyMinutes <= TARGET_MEDIAN_MINUTES),
      note: `median over ${audit.count} result(s), from the assumed whistle (kickoff + 105 min), from review results-audit`,
    });
  }

  if (settlement.due48h === 0) {
    rows.push(
      unknown(
        'settled_48h',
        'Matches settled or void 48 hours after kickoff',
        '100%',
        'no match of the week is 48 hours past kickoff yet',
      ),
    );
  } else {
    const share = settlement.settledOrVoid48h / settlement.due48h;
    rows.push({
      id: 'settled_48h',
      measure: 'Matches settled or void 48 hours after kickoff',
      target: '100%',
      value: pct(share),
      mark: mark(settlement.settledOrVoid48h >= settlement.due48h),
      note: `${ofCount(settlement.settledOrVoid48h, settlement.due48h)} matches that are 48 hours past kickoff`,
    });
  }

  if (audit.count === 0) {
    rows.push(
      unknown(
        'wrong_results',
        'Wrong results',
        'Fewer than 1 in 2,000 matches, each corrected forward within 72 hours',
        'no result of the week was applied at least 48 hours ago, so none could be audited',
      ),
    );
  } else {
    rows.push({
      id: 'wrong_results',
      measure: 'Wrong results',
      target: 'Fewer than 1 in 2,000 matches, each corrected forward within 72 hours',
      value: ofCount(audit.mismatches, audit.count),
      mark: mark(audit.mismatches / audit.count < WEEKLY_TARGETS.wrongRate),
      note: 'results that a source now contradicts (the source may be the wrong one); the 72-hour correction time is not measured yet',
    });
  }

  if (input.trust.length === 0) {
    rows.push(
      unknown(
        'trust',
        'Trust per upstream',
        'Trusted',
        'the scraper has no sources, so no upstream',
      ),
    );
  }
  for (const t of input.trust) {
    if (t.compared === 0) {
      rows.push(
        unknown(
          `trust:${t.upstream}`,
          `Trust of ${t.upstream}`,
          'Trusted',
          'nothing to compare yet: no finished result from this upstream matches an applied result',
        ),
      );
    } else {
      rows.push({
        id: `trust:${t.upstream}`,
        measure: `Trust of ${t.upstream}`,
        target: 'Trusted',
        value: `${t.trust} (${pct(t.agreed / t.compared)})`,
        mark: mark(t.trust === 'trusted'),
        note: `${ofCount(t.agreed, t.compared)} compared results agree, since 1 July; from sources truth-check`,
      });
    }
  }

  if (input.shadow.length === 0) {
    rows.push(
      unknown(
        'ladder_shadow',
        'Ladder shadow decisions',
        'No disagreement with what happened',
        'the result ladder made no decision in the week',
      ),
    );
  }
  for (const s of input.shadow) {
    const decided = s.agreed + s.disagreed;
    const counts = `${s.decisions} decision(s): ${s.agreed} agreed, ${s.disagreed} disagreed, ${s.pending} pending`;
    if (decided === 0) {
      rows.push(
        unknown(
          `ladder_shadow:${s.label}`,
          `Ladder shadow, ${s.label}`,
          'No disagreement with what happened',
          `${counts}; nothing has happened yet to compare with`,
        ),
      );
    } else {
      rows.push({
        id: `ladder_shadow:${s.label}`,
        measure: `Ladder shadow, ${s.label}`,
        target: 'No disagreement with what happened',
        value: ofCount(s.disagreed, decided),
        mark: mark(s.disagreed === 0),
        note: `${counts}; from review ladder-shadow`,
      });
    }
  }

  rows.push(
    unknown(
      'hand_steps',
      'Hand steps to add a league',
      '0',
      'the leagues sync log is not read by the report yet',
    ),
  );
  rows.push(
    unknown(
      'feed_cost',
      'Feed cost a month',
      '87 USD; 157 after step 3',
      'it is on the invoices; the report holds only credits (sources budget), not money',
    ),
  );
  return rows;
}

const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');

const MARK_TEXT: Record<Mark, string> = { pass: 'PASS', fail: 'FAIL', unknown: 'unknown' };

/** The report as a Markdown table and as a JSON document. */
export function buildWeeklyReport(input: WeeklyInputs): WeeklyReport {
  const measures = weeklyMeasures(input);
  const summary = {
    pass: measures.filter((m) => m.mark === 'pass').length,
    fail: measures.filter((m) => m.mark === 'fail').length,
    unknown: measures.filter((m) => m.mark === 'unknown').length,
  };
  const json: WeeklyReportJson = {
    week: {
      id: input.week.id,
      from: input.week.from.toISOString(),
      to: input.week.to.toISOString(),
    },
    generatedAt: input.generatedAt.toISOString(),
    summary,
    measures,
  };
  const markdown = [
    `# Weekly report ${input.week.id}`,
    '',
    `Matches kicking off from ${json.week.from} up to ${json.week.to}. Made ${json.generatedAt}.`,
    `Section 8 of docs/plans/hulusport-parity-plan.md: ${summary.pass} pass, ${summary.fail} fail, ${summary.unknown} unknown.`,
    '',
    '| Measure | Target | This week | Mark | Note |',
    '| --- | --- | --- | --- | --- |',
    ...measures.map(
      (m) =>
        `| ${cell(m.measure)} | ${cell(m.target)} | ${cell(m.value ?? '-')} | ${MARK_TEXT[m.mark]} | ${cell(m.note)} |`,
    ),
    '',
  ].join('\n');
  return { markdown, json };
}
