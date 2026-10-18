import type {
  DailyFiguresView,
  ReconciliationMismatchView,
  ReconciliationRunView,
} from '@vamos/contracts';
import { formatEtb, humanize } from './format';

/** Pure helpers for the compliance pages. Money stays a decimal string of santim. */

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar date `YYYY-MM-DD`. */
export function isBusinessDate(text: string): boolean {
  const m = DAY_RE.exec(text);
  if (m === null) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return (
    d.getUTCFullYear() === Number(m[1]) &&
    d.getUTCMonth() === Number(m[2]) - 1 &&
    d.getUTCDate() === Number(m[3])
  );
}

/** Whole days from `from` to `to` (inclusive count), or null if either is not a date. */
export function daysInRange(from: string, to: string): number | null {
  if (!isBusinessDate(from) || !isBusinessDate(to)) return null;
  const ms = (s: string) => Date.parse(`${s}T00:00:00Z`);
  return Math.round((ms(to) - ms(from)) / 86_400_000) + 1;
}

/** The report range typed for the CSV download: both dates, in order, at most 366 days. */
export function validateReportRange(from: string, to: string): string | null {
  const days = daysInRange(from, to);
  if (days === null) return 'Enter both dates as YYYY-MM-DD.';
  if (days < 1) return 'The end date must not be before the start date.';
  if (days > 366) return 'The range is at most 366 days.';
  return null;
}

/** File name of a downloaded daily summary CSV. */
export function summaryCsvName(from: string, to: string): string {
  return `daily-summaries-${from}-to-${to}.csv`;
}

/** Santim difference as a signed decimal string (BigInt, never floating point). */
export function diffSantim(expected: string | null, actual: string | null): string | null {
  if (expected === null || actual === null) return null;
  if (!/^-?\d+$/.test(expected) || !/^-?\d+$/.test(actual)) return null;
  return (BigInt(actual) - BigInt(expected)).toString();
}

/** The figures of a day as labelled rows (money formatted, counts plain). */
export function figureRows(f: DailyFiguresView): [string, string][] {
  const e = formatEtb;
  return [
    ['Turnover', e(f.turnover)],
    ['  Bet stakes', `${e(f.betStakes)} (${f.betCount} bets)`],
    ['  Jackpot entries', `${e(f.jackpotStakes)} (${f.jackpotEntryCount})`],
    ['Payouts (gross)', e(f.payouts)],
    ['  Winnings paid', e(f.wonPayouts)],
    ['  Cash-outs', e(f.cashOuts)],
    ['  Refunds and voids', e(f.refunds)],
    ['  Jackpot prizes', e(f.jackpotPrizes)],
    ['GGR', e(f.ggr)],
    ['Tax withheld', e(f.taxWithheld)],
    ['Bonuses', e(f.bonuses)],
    ['Deposits', `${e(f.deposits)} (${f.depositCount})`],
    ['Withdrawals', `${e(f.withdrawals)} (${f.withdrawalCount})`],
    ['Active players', String(f.activePlayers)],
    ['ELS commission rate', formatBps(f.commissionRateBps)],
    ['ELS commission due', e(f.commissionDue)],
  ];
}

/** "1500" bps → "15.00%". */
export function formatBps(bps: number): string {
  const text = String(Math.max(0, Math.trunc(bps))).padStart(3, '0');
  return `${text.slice(0, -2)}.${text.slice(-2)}%`;
}

/** One-line description of a reconciliation mismatch for the table. */
export function describeMismatch(m: ReconciliationMismatchView): string {
  const diff = diffSantim(m.expected, m.actual);
  const values =
    m.expected === null && m.actual === null
      ? ''
      : ` expected ${m.expected ?? '–'}, found ${m.actual ?? '–'}${diff === null ? '' : ` (difference ${diff})`}`;
  return `${humanize(m.check)}: ${humanize(m.subjectType)} ${m.subjectId}${values}`;
}

/** The checks of a run that failed. */
export function failedChecks(run: ReconciliationRunView): string[] {
  return run.checks.filter((c) => !c.ok).map((c) => humanize(c.check));
}

/** A PSP statement upload: a file name and CSV text must be present and plausible. */
export function validateStatementUpload(input: { csv: string; provider: string }): string | null {
  if (input.csv.trim() === '') return 'Choose a CSV file.';
  if (input.csv.length > 5_000_000) return 'The file is larger than 5 MB.';
  const provider = input.provider.trim();
  if (provider !== '' && !/^[a-z0-9_-]{2,32}$/.test(provider))
    return 'The provider is 2 to 32 lowercase letters, digits, - or _.';
  return null;
}

/** AML review decisions allowed from a status (matches the API's state machine). */
export function reviewDecisions(status: string): ('reviewed' | 'dismissed' | 'escalated')[] {
  if (status === 'open') return ['reviewed', 'dismissed', 'escalated'];
  if (status === 'escalated') return ['reviewed', 'dismissed'];
  return [];
}
