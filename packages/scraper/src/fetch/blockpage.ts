/**
 * Block-page detection (docs/scraper.md 6.3 S2). A bot-protection challenge is
 * often served with status 200, so status alone cannot be trusted. We look for
 * well-known markers and treat a hit as "blocked": we back off and never try to
 * get past it. A false positive costs one skipped run; a false negative would
 * feed a challenge page to a parser, so the list errs on the wide side.
 */

export const BLOCK_PAGE_STATUSES: ReadonlySet<number> = new Set([200, 403, 429, 503]);
export const BLOCK_PAGE_SCAN_BYTES = 4096;

const MARKERS = [
  'captcha',
  'cf-chl',
  'cf-browser-verification',
  'attention required',
  'access denied',
  'are you a robot',
  'are you human',
  'ddos protection',
  'checking your browser',
  '_incapsula_',
];

/** True when the first 4 KB of a 200/403/429/503 response look like a challenge page. */
export function detectBlockPage(status: number, body: Uint8Array): boolean {
  if (!BLOCK_PAGE_STATUSES.has(status)) return false;
  const head = new TextDecoder('utf-8')
    .decode(body.subarray(0, BLOCK_PAGE_SCAN_BYTES))
    .toLowerCase();
  return MARKERS.some((marker) => head.includes(marker));
}
