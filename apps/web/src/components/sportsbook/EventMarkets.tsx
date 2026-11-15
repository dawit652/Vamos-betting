import type { EventDetail } from '@vamos/contracts';
import { eventRef } from './events';
import { MarketSections } from './MarketSections';

/**
 * All of an event's open and suspended markets: "Main" as one accordion per
 * market type, plus a collapsible section per market-factory group (see
 * MarketSections, a client island because of the chips and search).
 */
export function EventMarkets({ event }: { event: EventDetail }) {
  const bettingOpen = event.status === 'scheduled' || event.status === 'live';
  return (
    <div className="px-3 pt-3 lg:px-0">
      <MarketSections markets={event.markets} event={eventRef(event)} bettingOpen={bettingOpen} />
    </div>
  );
}
