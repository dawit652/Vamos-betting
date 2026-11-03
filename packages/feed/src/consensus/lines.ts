import type { BookQuote } from './consensus';

/**
 * Lines of the totals and spreads markets. Only half-point lines are offered
 * (2.5, 224.5, -1.5): a whole line can push and a quarter line splits the
 * stake, and the catalogue settles neither (see parseLine in @vamos/core).
 * Bookmakers quote different main lines (one 2.5, another 2.75), so quotes
 * are grouped by line before the consensus is taken.
 */

/** A quote on one line; for spreads the line is the home side's handicap. */
export interface LineQuote extends BookQuote {
  line: number;
}

/** True for a finite x.5 line (positive or negative). */
export function isHalfPointLine(line: number): boolean {
  if (!Number.isFinite(line)) return false;
  const doubled = line * 2;
  return Number.isInteger(doubled) && Math.abs(doubled) % 2 === 1;
}

/** The line as the catalogue writes it: "2.5", "224.5", "-1.5". */
export function formatLine(line: number): string {
  if (!isHalfPointLine(line)) throw new RangeError(`not a half-point line: ${line}`);
  return line.toFixed(1);
}

/** Quotes grouped by half-point line, lines ascending; other lines are dropped. */
export function groupByLine(quotes: readonly LineQuote[]): Map<number, BookQuote[]> {
  const groups = new Map<number, BookQuote[]>();
  for (const quote of quotes) {
    if (!isHalfPointLine(quote.line)) continue;
    const group = groups.get(quote.line) ?? [];
    group.push({ bookmaker: quote.bookmaker, updatedAt: quote.updatedAt, prices: quote.prices });
    groups.set(quote.line, group);
  }
  return new Map([...groups.entries()].sort(([a], [b]) => a - b));
}

export interface LineCandidate {
  line: number;
  /** Books behind the line's consensus. */
  books: number;
  /** Consensus probability of the first outcome (over, or the home side). */
  probability: number;
}

/**
 * The main line: the one most books quote; on a tie the one closest to an
 * even split, then the lower line. Null when there is no candidate.
 */
export function mainLine(candidates: readonly LineCandidate[]): number | null {
  let best: LineCandidate | null = null;
  for (const candidate of candidates) {
    if (best === null || better(candidate, best)) best = candidate;
  }
  return best?.line ?? null;
}

function better(a: LineCandidate, b: LineCandidate): boolean {
  if (a.books !== b.books) return a.books > b.books;
  const evenA = Math.abs(a.probability - 0.5);
  const evenB = Math.abs(b.probability - 0.5);
  // Equally even within float noise (0.45 and 0.55) is a tie.
  if (Math.abs(evenA - evenB) > 1e-9) return evenA < evenB;
  return a.line < b.line;
}
