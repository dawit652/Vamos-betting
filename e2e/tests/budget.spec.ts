import { expect, test } from '@playwright/test';

/**
 * Page-weight budget: bytes transferred (compressed bodies plus headers, as
 * the network sees them) by a first, cold-cache load of the home page by an
 * anonymous visitor on a phone, until the network is idle. Router prefetches
 * of other pages are speculative and reported separately, not counted.
 *
 * The plan's target is 150 KB. The Next 16 + React 19 runtime is about 110 KB
 * of it even with brotli, so the web app runs behind apps/web/server.mjs
 * (next start plus brotli: static JS/CSS at maximum quality, pages at a fast
 * level). Measured on 10 Oct 2026 against server.mjs: 149.8 KB = JS 129.4 KB +
 * HTML 14.8 KB + CSS 5.7 KB, in 12 requests (headers included); with plain
 * `next start` (gzip) it was 179 KB. Measured on 14 Nov 2026 after the redesign
 * (dark theme, league navigation, featured poster, docked betslip): 158.4 KB =
 * JS 130.7 KB + HTML 18.6 KB + CSS 7.4 KB + the session fetch, in 14 requests;
 * the previous UI weighed about 153 KB on the same data, so the page is over the
 * target and has little room left. Later that day the betslip drawer's text
 * moved from every page to the drawer's own chunk: 157.7 KB on the same data
 * (HTML 0.8 KB lighter, JS 0.1 KB heavier). With the list controls (search
 * link, 1X2 / double chance switch) and 16 rows instead of 20 on the first
 * Highlights page: 156.8 KB = JS 130.8 KB + HTML 16.9 KB + CSS 7.5 KB. The
 * budget leaves a little room for the HTML, which grows with the listed matches
 * (about 0.35 KB per row). Lower it when the page gets lighter; raise it only
 * with a reason.
 */
const TARGET_BYTES = 150 * 1024;
const BUDGET_BYTES = 159 * 1024; // measured 156.8 KB (14 Nov 2026): 2.2 KB of room

interface Transfer {
  url: string;
  type: string;
  bytes: number;
  prefetch: boolean;
}

const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;

test('first home page load stays within the page-weight budget', async ({ page, request }) => {
  const html = await (await request.get('/')).text();
  test.skip(
    html.includes('hmr-client'),
    'the web app runs in dev mode (next dev); the budget applies to a production build (next start)',
  );

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });

  const pending = new Map<string, { url: string; type: string; prefetch: boolean }>();
  const transfers: Transfer[] = [];
  cdp.on('Network.requestWillBeSent', (event) => {
    const headers = Object.fromEntries(
      Object.entries(event.request.headers).map(([name, value]) => [name.toLowerCase(), value]),
    );
    pending.set(event.requestId, {
      url: event.request.url,
      type: event.type ?? 'Other',
      prefetch:
        headers['next-router-prefetch'] !== undefined ||
        headers['purpose'] === 'prefetch' ||
        headers['sec-purpose']?.startsWith('prefetch') === true,
    });
  });
  cdp.on('Network.loadingFinished', (event) => {
    const request = pending.get(event.requestId);
    if (request !== undefined) transfers.push({ ...request, bytes: event.encodedDataLength });
  });

  await page.goto('/', { waitUntil: 'load' });
  await page.waitForLoadState('networkidle');
  // Late lazy chunks (hydration-time imports) settle within a moment of idle.
  await page.waitForTimeout(500);

  const counted = transfers.filter((t) => !t.prefetch && !t.url.startsWith('data:'));
  const prefetched = transfers.filter((t) => t.prefetch);
  const total = counted.reduce((sum, t) => sum + t.bytes, 0);
  const byType = new Map<string, number>();
  for (const t of counted) byType.set(t.type, (byType.get(t.type) ?? 0) + t.bytes);

  const report = [
    `home page, first load: ${kb(total)} transferred in ${counted.length} requests ` +
      `(target ${kb(TARGET_BYTES)}, budget ${kb(BUDGET_BYTES)})`,
    ...[...byType.entries()].sort((a, b) => b[1] - a[1]).map(([type, n]) => `  ${type}: ${kb(n)}`),
    `  not counted: ${prefetched.length} router prefetches, ` +
      kb(prefetched.reduce((sum, t) => sum + t.bytes, 0)),
    ...counted
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 8)
      .map((t) => `    ${kb(t.bytes).padStart(9)}  ${new URL(t.url).pathname}`),
  ].join('\n');
  console.log(report);
  await test.info().attach('page-weight.txt', { body: report, contentType: 'text/plain' });

  if (total > TARGET_BYTES) {
    test.info().annotations.push({
      type: 'over target',
      description: `${kb(total)} is over the ${kb(TARGET_BYTES)} target (budget ${kb(BUDGET_BYTES)})`,
    });
  }
  expect(total, report).toBeLessThanOrEqual(BUDGET_BYTES);
});
