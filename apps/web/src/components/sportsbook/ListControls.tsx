import Link from 'next/link';
import { getLocale, getT } from '@/i18n/server';
import { formatWeekday } from '@/lib/format';
import { chipDays, ROW_MARKETS, type RowMarket } from './tabs';

/**
 * The controls between the tabs and a match list, all plain links (the lists
 * render on the server): the day chips of the Today tab and, for football, the
 * switch between 1X2 and double chance odds on the rows (on a phone the chips
 * take a row of their own). Renders nothing when the list has neither.
 */
export async function ListControls({
  days,
  market,
}: {
  /** The Today tab: the chosen day (undefined is today) and the link to a day. */
  days?: { current: string | undefined; href: (day: string | undefined) => string };
  /** Football lists: the market on the rows and the link to the other one. */
  market?: { current: RowMarket; href: (market: RowMarket) => string };
}) {
  if (days === undefined && market === undefined) return null;
  const [t, locale] = await Promise.all([getT(), getLocale()]);
  const [today, ...later] = chipDays();
  return (
    <div className="mx-3 mb-3 flex flex-wrap items-center gap-2 lg:mx-0 lg:flex-nowrap">
      {days !== undefined ? (
        <nav
          aria-label={t('sportsbook.controls.days')}
          className="no-scrollbar flex min-w-0 flex-none basis-full gap-1.5 overflow-x-auto lg:flex-1 lg:basis-0"
        >
          {[undefined, ...later].map((day, index) => (
            <Link
              key={day ?? today}
              href={days.href(day)}
              prefetch={false}
              aria-current={day === days.current ? 'page' : undefined}
              className="chip"
            >
              {day === undefined
                ? t('sportsbook.tabs.today')
                : index === 1
                  ? t('sportsbook.list.tomorrow')
                  : formatWeekday(day, locale)}
            </Link>
          ))}
        </nav>
      ) : null}
      {market !== undefined ? (
        <nav
          aria-label={t('sportsbook.controls.market')}
          className="ml-auto flex flex-none rounded-full border border-line bg-surface p-0.5 text-xxs font-bold"
        >
          {ROW_MARKETS.map((option) => (
            <Link
              key={option}
              href={market.href(option)}
              prefetch={false}
              aria-current={option === market.current ? 'page' : undefined}
              className={`rounded-full px-2.5 py-1.5 ${
                option === market.current ? 'bg-brand text-brand-ink' : 'text-muted hover:text-ink'
              }`}
            >
              {t(`sportsbook.controls.${option}`)}
            </Link>
          ))}
        </nav>
      ) : null}
    </div>
  );
}
