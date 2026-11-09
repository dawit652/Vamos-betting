import { smsBirrToSantim, type Santim } from '@vamos/core';
import type { ReceiptFacts } from './types';

/**
 * Reading Ethio Telecom's public receipt page (server-rendered HTML). The
 * markup is not ours, so nothing here depends on structure, classes or
 * column order: the page is flattened to text and each field is found next
 * to one of its labels, independently. When it stops working it returns
 * null and the check is `indeterminate`: latency to a person, never a wrong
 * or lost credit. The raw page is kept (receipt_raw) to write the next
 * fixture from.
 */

/** What telebirr serves for an unknown reference. */
const NOT_FOUND_MARKERS = [
  /this\s+request\s+is\s+not\s+correct/i,
  /no\s+such\s+transaction/i,
  /transaction\s+not\s+found/i,
  /invalid\s+(?:transaction|receipt|request)/i,
];

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
};

/** HTML to one line of text; tags become spaces so adjacent cells do not fuse. */
export function flattenHtml(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d{1,6});/g, (_, code: string) => {
      const n = Number(code);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ' ';
    })
    .replace(/&[a-z]+;/gi, (e) => ENTITIES[e.toLowerCase()] ?? ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Shorter than this is an error page or a truncated answer. */
const MIN_RECEIPT_TEXT = 200;

const AMOUNT_GLOBAL =
  /(?:ETB|Birr|ብር)\s*(\d[\d,]*(?:\.\d{1,2})?)|(\d[\d,]*(?:\.\d{1,2})?)\s*(?:ETB|Birr|ብር)/gi;
const BALANCE_CONTEXT = /(balance|bal\.?|ቀሪ\s*ሂሳብ|ቀሪ)\s*(?:is|of|:)?\s*$/i;

/** Filler between a label and its value ("is", "no", ":"), bounded so a label never pairs with another row. */
const WIDE_GAP = String.raw`(?:\s|[:=\-–—.]|\bis\b|\bno\b|\bnumber\b|\baccount\b){0,6}`;
const THIN_GAP = String.raw`\s*[:\-–—]?\s*`;
const FIELD_BREAK =
  'payer|credited|debited|receiver|recipient|payee|sender|transaction|status|payment|service|vat|amount|total|date|ETB|Birr|ብር';
const NAME_VALUE = String.raw`[A-Za-zሀ-፿][A-Za-zሀ-፿ .'*-]{1,60}?`;
const ACCOUNT_VALUE = String.raw`[\d*x•·#+]{6,20}`;
const NAME_TAIL = String.raw`(?=\s+(?:${FIELD_BREAK})\b|\s*$)`;

const labelled = (alts: string, gap: string, value: string, tail = '') =>
  new RegExp(`(?:${alts})${gap}(${value})${tail}`, 'i');

const LABELS = {
  reference: labelled(
    String.raw`transaction\s*(?:number|id|no\.?)|receipt\s*(?:number|no\.?)|reference|የግብይት\s*ቁጥር`,
    WIDE_GAP,
    String.raw`[A-Z0-9]{6,25}`,
  ),
  payerName: labelled(
    String.raw`payer\s*name|sender\s*name|from\s*name|debited\s*party\s*name|የከፋይ\s*ስም`,
    THIN_GAP,
    NAME_VALUE,
    NAME_TAIL,
  ),
  payerAccount: labelled(
    String.raw`payer\s*(?:telebirr|account|phone|msisdn)|sender\s*(?:account|phone)|debited\s*party\s*account|የከፋይ\s*ስልክ`,
    WIDE_GAP,
    ACCOUNT_VALUE,
  ),
  receiverName: labelled(
    String.raw`credited\s*party\s*name|receiver\s*name|recipient\s*name|payee\s*name|to\s*name|የተቀባይ\s*ስም`,
    THIN_GAP,
    NAME_VALUE,
    NAME_TAIL,
  ),
  receiverAccount: labelled(
    String.raw`credited\s*party\s*(?:account|telebirr|phone)|receiver\s*(?:account|phone|msisdn)|recipient\s*account|የተቀባይ\s*ስልክ`,
    WIDE_GAP,
    ACCOUNT_VALUE,
  ),
  status: labelled(
    String.raw`transaction\s*status|payment\s*status|status|ሁኔታ`,
    THIN_GAP,
    String.raw`[A-Za-zሀ-፿]{3,20}`,
  ),
  date: labelled(
    String.raw`payment\s*date|transaction\s*(?:date|time)|date|ቀን`,
    THIN_GAP,
    String.raw`\d{1,2}[-/]\d{1,2}[-/]\d{2,4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?`,
  ),
} as const;

function find(text: string, pattern: RegExp): string | null {
  const found = pattern.exec(text)?.[1]?.trim();
  return found ? found : null;
}

function collectAmounts(text: string): Santim[] {
  const out: Santim[] = [];
  for (const match of text.matchAll(AMOUNT_GLOBAL)) {
    const raw = match[1] ?? match[2];
    if (!raw) continue;
    if (BALANCE_CONTEXT.test(text.slice(Math.max(0, match.index - 30), match.index))) continue;
    const value = smsBirrToSantim(raw);
    if (value !== null && value > 0n) out.push(value);
  }
  return out;
}

const COMPLETED = /^(completed|success(?:ful)?|paid|done|ተጠናቋል|ተሳክቷል)$/i;
const FAILED = /^(failed|pending|cancel(?:led)?|reversed|አልተሳካም)$/i;

/** dd/mm/yyyy [hh:mm] in EAT (UTC+3). */
function parseReceiptDate(raw: string | null): Date | null {
  if (!raw) return null;
  const m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})(?:\s+(\d{1,2}):(\d{2}))?/.exec(raw.trim());
  if (!m) return null;
  const [, d, mo, y, hh, mm] = m;
  const year = Number(y!.length === 2 ? `20${y}` : y);
  const date = new Date(
    Date.UTC(year, Number(mo) - 1, Number(d), Number(hh ?? 0) - 3, Number(mm ?? 0)),
  );
  return Number.isNaN(date.getTime()) ? null : date;
}

/** True when the page is telebirr's "no such transaction" answer. */
export function isReceiptNotFoundPage(html: string): boolean {
  const text = flattenHtml(html);
  return NOT_FOUND_MARKERS.some((marker) => marker.test(text));
}

/** The receipt's facts, or null when the page does not look like a receipt at all. */
export function parseTelebirrReceipt(html: string): ReceiptFacts | null {
  if (typeof html !== 'string' || !html.trim()) return null;
  const text = flattenHtml(html);
  if (text.length < MIN_RECEIPT_TEXT) return null;
  if (NOT_FOUND_MARKERS.some((marker) => marker.test(text))) return null;
  const amounts = collectAmounts(text);
  const reference = find(text, LABELS.reference);
  if (reference === null && amounts.length === 0) return null;
  const statusWord = find(text, LABELS.status);
  const completed =
    statusWord === null
      ? null
      : COMPLETED.test(statusWord)
        ? true
        : FAILED.test(statusWord)
          ? false
          : null;
  return {
    reference: reference?.toUpperCase() ?? null,
    amounts,
    payerName: find(text, LABELS.payerName),
    payerAccount: find(text, LABELS.payerAccount),
    receiverName: find(text, LABELS.receiverName),
    receiverAccount: find(text, LABELS.receiverAccount),
    completed,
    occurredAt: parseReceiptDate(find(text, LABELS.date)),
  };
}
