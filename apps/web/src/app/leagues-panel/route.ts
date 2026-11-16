import { NextResponse, type NextRequest } from 'next/server';
import { panelLeagues, type PanelData } from '@/components/sportsbook/panel';
import { getLocale } from '@/i18n/server';
import { getCompetitions } from '@/lib/api/catalog';
import { isSport } from '@/lib/routes';
import { telegramUrl } from '@/lib/telegram';

/**
 * The phone league panel's rows, fetched when the panel is opened so the home page does not
 * carry them (page-weight budget). Same data and order as the desktop column.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const sport = request.nextUrl.searchParams.get('sport') ?? '';
  if (!isSport(sport)) return NextResponse.json({ error: 'unknown sport' }, { status: 400 });
  const [locale, competitions] = await Promise.all([
    getLocale(),
    getCompetitions(sport).catch(() => null),
  ]);
  const body: PanelData = { ...panelLeagues(competitions, sport, locale), telegram: telegramUrl() };
  return NextResponse.json(body, { headers: { 'cache-control': 'no-store' } });
}
