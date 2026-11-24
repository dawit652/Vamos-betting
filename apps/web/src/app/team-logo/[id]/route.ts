import { NextResponse } from 'next/server';
import { serverApiUrl } from '@/lib/api/config';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A team's logo (owner, 17 Nov 2026), fetched from the API and served from the site's own origin:
 * the page's CSP allows only its own images. The URL carries the logo's version, so a week of
 * browser cache is safe; a missing logo is a short-cached 404 (the page shows initials instead).
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const missing = () =>
    new NextResponse(null, { status: 404, headers: { 'cache-control': 'public, max-age=3600' } });
  if (!UUID.test(id)) return missing();
  const upstream = await fetch(`${serverApiUrl()}/teams/${id}/logo`, {
    signal: AbortSignal.timeout(5_000),
  }).catch(() => null);
  if (upstream === null || !upstream.ok) return missing();
  return new NextResponse(await upstream.arrayBuffer(), {
    headers: {
      'content-type': 'image/png',
      'cache-control': 'public, max-age=604800, immutable',
      'x-content-type-options': 'nosniff',
    },
  });
}
