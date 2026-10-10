'use client';

import type { SelectionView } from '@vamos/contracts';
import { useEffect, useRef, useState } from 'react';
import { useLocale, useT } from '@/i18n/client';
import { MAX_SLIP_LEGS } from '@/lib/betslip/state';
import { formatOddsMilli } from '@/lib/format';
import { localName } from '@/lib/localized';
import { useBetslip } from '@/providers/BetslipProvider';
import { isBettable, shortLabel, slipLeg, type EventRef, type OddsMarket } from './events';
import { useLiveMarketStatus, useLiveMatch, useLiveOdds } from './LiveProvider';
import styles from './odds.module.css';

/**
 * The odds buttons of one market: a list row's 1X2 (`row`, labelled by code)
 * or an event page market (`grid`, labelled by selection). Tapping toggles the
 * pick on the betslip; live deltas (inside a LiveProvider) patch prices and
 * suspension.
 */
export function MarketOdds({
  event,
  market,
  layout,
  bettingOpen = true,
}: {
  event: EventRef;
  market: OddsMarket;
  layout: 'row' | 'grid';
  /** The server's view of the event (false once it is finished, etc.). */
  bettingOpen?: boolean;
}) {
  const t = useT();
  const status = useLiveMarketStatus(market.id, market.status);
  const match = useLiveMatch(event.eventId);
  const open = status === 'open' && (match?.bettingOpen ?? bettingOpen);
  const columns =
    layout === 'row' ? market.selections.length : market.selections.length === 2 ? 2 : 3;

  return (
    <div className="relative min-w-0 flex-1">
      <div
        className="grid gap-1"
        style={{ gridTemplateColumns: `repeat(${Math.max(columns, 1)}, minmax(0, 1fr))` }}
      >
        {market.selections.map((selection) => (
          <OddsButton
            key={selection.id}
            event={event}
            market={market}
            selection={selection}
            marketOpen={open}
            layout={layout}
          />
        ))}
      </div>
      {status === 'suspended' ? (
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-xxs font-bold text-muted uppercase">
          <span className="rounded-sm bg-surface/90 px-1">{t('sportsbook.markets.suspended')}</span>
        </span>
      ) : null}
    </div>
  );
}

function OddsButton({
  event,
  market,
  selection,
  marketOpen,
  layout,
}: {
  event: EventRef;
  market: OddsMarket;
  selection: SelectionView;
  marketOpen: boolean;
  layout: 'row' | 'grid';
}) {
  const t = useT();
  const locale = useLocale();
  const slip = useBetslip();
  const live = useLiveOdds(selection.id, { oddsMilli: selection.oddsMilli, open: selection.open });
  const enabled = isBettable({
    marketStatus: marketOpen ? 'open' : 'suspended',
    selectionOpen: live.open,
    bettingOpen: true,
    oddsMilli: live.oddsMilli,
  });
  const selected = slip.has(selection.id);
  const label = layout === 'row' ? shortLabel(selection.code) : localName(selection.label, locale);
  const move = usePriceMove(live.oddsMilli);

  return (
    <button
      type="button"
      className="odds-btn relative px-1"
      aria-pressed={selected}
      // A selection already on the slip can always be removed.
      disabled={!enabled && !selected}
      title={localName(selection.label, locale)}
      onClick={() => {
        const outcome = slip.toggle(slipLeg(event, market, selection, live.oddsMilli));
        if (outcome === 'limit') {
          window.alert(t('common.betslip.limitReached', { max: MAX_SLIP_LEGS }));
        }
      }}
    >
      <span className="odds-label w-full truncate">{label}</span>
      <span>{enabled ? formatOddsMilli(live.oddsMilli) : '–'}</span>
      {enabled && move !== null ? (
        <span
          key={live.oddsMilli}
          aria-hidden="true"
          className={`${styles.move} absolute top-0.5 right-0.5 text-[0.5rem] leading-none ${
            move === 'up' ? 'text-up' : 'text-down'
          }`}
        >
          {move === 'up' ? '▲' : '▼'}
        </span>
      ) : null}
    </button>
  );
}

/** Direction of the last live price change (the arrow fades out by itself). */
function usePriceMove(oddsMilli: number): 'up' | 'down' | null {
  const previous = useRef(oddsMilli);
  const [move, setMove] = useState<'up' | 'down' | null>(null);
  useEffect(() => {
    if (oddsMilli === previous.current) return;
    setMove(oddsMilli > previous.current ? 'up' : 'down');
    previous.current = oddsMilli;
  }, [oddsMilli]);
  return move;
}
