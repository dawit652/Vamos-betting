import type { EventDetail } from '@vamos/contracts';
import { getLocale, getT } from '@/i18n/server';
import { localName } from '@/lib/localized';
import { eventRef, groupMarkets, oddsMarket } from './events';
import { MarketOdds } from './MarketOdds';

/** Accordions opened on first view; the rest stay closed to keep the page short. */
const OPEN_GROUPS = 4;

/**
 * All of an event's open and suspended markets, one native <details>
 * accordion per market type (no JavaScript needed to expand them). Only the
 * odds buttons are client islands.
 */
export async function EventMarkets({ event }: { event: EventDetail }) {
  const [t, locale] = await Promise.all([getT(), getLocale()]);
  const groups = groupMarkets(event.markets);
  const ref = eventRef(event);
  const bettingOpen = event.status === 'scheduled' || event.status === 'live';
  if (groups.length === 0) {
    return <p className="card m-3 text-center text-muted">{t('sportsbook.markets.none')}</p>;
  }
  return (
    <div className="space-y-px">
      {groups.map((group, index) => (
        <details key={group.type} open={index < OPEN_GROUPS} className="group bg-surface">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 font-semibold [&::-webkit-details-marker]:hidden">
            <span className="truncate">{localName(group.name, locale)}</span>
            <span
              aria-hidden="true"
              className="text-muted transition-transform group-open:rotate-180"
            >
              ▾
            </span>
          </summary>
          <div className="space-y-1.5 px-3 pb-3">
            {group.markets.map((market) => (
              <MarketOdds
                key={market.id}
                event={ref}
                market={oddsMarket(market)}
                layout="grid"
                bettingOpen={bettingOpen}
              />
            ))}
          </div>
        </details>
      ))}
    </div>
  );
}
