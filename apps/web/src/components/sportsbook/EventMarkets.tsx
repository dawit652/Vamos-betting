import type { EventDetail } from '@vamos/contracts';
import { getLocale, getT } from '@/i18n/server';
import { localName } from '@/lib/localized';
import { eventRef, groupMarkets, marketCategories, marketCategory, oddsMarket } from './events';
import { Chevron } from './MatchList';
import { MarketOdds } from './MarketOdds';

/** Accordions opened on first view; the rest stay closed to keep the page short. */
const OPEN_GROUPS = 4;

/**
 * All of an event's open and suspended markets, one native <details> card per
 * market type, under filter chips (All / Main / Totals / Halves / More). The
 * chips are radio buttons and the filtering is CSS (`.market-filter` in
 * globals.css), so neither needs JavaScript. Only the odds buttons are client
 * islands.
 */
export async function EventMarkets({ event }: { event: EventDetail }) {
  const [t, locale] = await Promise.all([getT(), getLocale()]);
  const groups = groupMarkets(event.markets);
  const ref = eventRef(event);
  const bettingOpen = event.status === 'scheduled' || event.status === 'live';
  if (groups.length === 0) {
    return (
      <p className="card mx-3 mt-3 text-center text-muted lg:mx-0">
        {t('sportsbook.markets.none')}
      </p>
    );
  }
  const categories = marketCategories(groups);
  return (
    <div className="px-3 pt-3 lg:px-0">
      {categories.length > 1 ? (
        <fieldset className="market-filter no-scrollbar -mx-3 mb-3 flex gap-2 overflow-x-auto px-3 lg:mx-0 lg:px-0">
          <legend className="sr-only">{t('sportsbook.markets.filter.label')}</legend>
          {(['all', ...categories] as const).map((category) => (
            <label key={category} className="chip cursor-pointer has-focus-visible:outline-2">
              <input
                type="radio"
                name="market-filter"
                value={category}
                defaultChecked={category === 'all'}
                className="sr-only"
              />
              {t(`sportsbook.markets.filter.${category}`)}
            </label>
          ))}
        </fieldset>
      ) : null}
      <div className="market-groups space-y-2">
        {groups.map((group, index) => (
          <details
            key={group.type}
            open={index < OPEN_GROUPS}
            data-cat={marketCategory(group.type)}
            className="group panel"
          >
            <summary className="flex items-center justify-between gap-2 px-3 py-2.5 font-bold">
              <span className="truncate">{localName(group.name, locale)}</span>
              <Chevron />
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
    </div>
  );
}
