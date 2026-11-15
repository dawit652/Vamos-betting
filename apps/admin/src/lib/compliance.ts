import type {
  ReconciliationMismatchView,
  ReconciliationRequestView,
  ReconciliationRunView,
} from '@vamos/contracts';
import { humanize } from './format';

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

/** Santim difference as a signed decimal string (BigInt, never floating point). */
export function diffSantim(expected: string | null, actual: string | null): string | null {
  if (expected === null || actual === null) return null;
  if (!/^-?\d+$/.test(expected) || !/^-?\d+$/.test(actual)) return null;
  return (BigInt(actual) - BigInt(expected)).toString();
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

/** How often the "Run now" form polls its request, and for how long at most. */
export const RECONCILIATION_POLL_MS = 1000;
export const RECONCILIATION_POLL_LIMIT_MS = 10 * 60_000;

/**
 * The "Run now" form's message for a request: still waiting (queued or
 * running), finished (the run's outcome) or failed. `run` is the run once
 * the request is done.
 */
export function reconciliationRequestMessage(
  request: Pick<ReconciliationRequestView, 'status' | 'error'>,
  run?: Pick<ReconciliationRunView, 'status' | 'mismatchCount'> | null,
): { kind: 'ok' | 'error' | 'pending'; text: string } {
  switch (request.status) {
    case 'queued':
      return { kind: 'pending', text: 'Queued: the worker will run it in a moment…' };
    case 'running':
      return { kind: 'pending', text: 'Running: checking the ledger, wallets and payments…' };
    case 'failed':
      return { kind: 'error', text: `Run failed: ${request.error ?? 'unknown error'}` };
    case 'done':
      if (run === undefined || run === null) return { kind: 'pending', text: 'Finishing…' };
      return {
        kind: run.status === 'clean' ? 'ok' : 'error',
        text: `Run ${run.status}: ${run.mismatchCount} mismatches.`,
      };
  }
}
