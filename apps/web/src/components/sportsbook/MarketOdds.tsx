'use client';

import type { SelectionView } from '@vamos/contracts';
import { useEffect, useRef, useState } from 'react';
import { useLocale, useT } from '@/i18n/client';
import { MAX_SLIP_LEGS } from '@/lib/betslip/state';
import { formatOddsMilli } from '@/lib/format';
import { localName } from '@/lib/localized';
import { useBetslip } from '@/providers/BetslipProvider';
import {
  codePrefix,
  isBettable,
  shortLabel,
  slipLeg,
  type EventRef,
  type OddsMarket,
} from './events';
import { useLiveMarketStatus, useLiveMatch, useLiveOdds } from './LiveProvider';
import styles from './odds.module.css';

/**
 * The odds buttons of one market: a list row's 1X2 (`row`, labelled by code)
 * or an event page market (`grid`, labelled by selection; a two-way market
 * puts the label left and the price right). Tapping toggles the
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
        className="grid gap-1.5"
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
            wide={layout === 'grid' && columns === 2}
          />
        ))}
      </div>
      {status === 'suspended' ? (
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-xxs font-bold text-muted uppercase">
          <span className="rounded-full bg-surface/90 px-2">
            {t('sportsbook.markets.suspended')}
          </span>
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
  wide,
}: {
  event: EventRef;
  market: OddsMarket;
  selection: SelectionView;
  marketOpen: boolean;
  layout: 'row' | 'grid';
  /** Label left, price right (a two-way market on the event page). */
  wide: boolean;
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
  const name = localName(selection.label, locale);
  const label = layout === 'row' ? shortLabel(selection.code) : name;
  // "1X Manchester United or Draw": the code keeps long names apart once they are cut short.
  const prefix = layout === 'grid' ? codePrefix(selection.code, name) : null;
  const move = usePriceMove(live.oddsMilli);
  // The visible "1 / 1.68" says nothing to a screen reader on a list of 20
  // rows: name the selection, the market and the match, and the price or that it is suspended.
  const described = {
    selection: name,
    market: localName(market.name, locale),
    event: t('sportsbook.match.versus', {
      home: localName(event.home, locale),
      away: localName(event.away, locale),
    }),
  };
  const ariaLabel = enabled
    ? t('sportsbook.markets.oddsLabel', { ...described, odds: formatOddsMilli(live.oddsMilli) })
    : t('sportsbook.markets.oddsLabelSuspended', described);

  return (
    <button
      type="button"
      className={`odds-btn relative ${wide ? 'odds-btn-wide' : 'px-1'} ${
        layout === 'grid' ? 'odds-btn-market' : ''
      }`}
      aria-pressed={selected}
      // A selection already on the slip can always be removed.
      disabled={!enabled && !selected}
      aria-label={ariaLabel}
      title={name}
      onClick={() => {
        const outcome = slip.toggle(slipLeg(event, market, selection, live.oddsMilli));
        if (outcome === 'limit') {
          window.alert(t('common.betslip.limitReached', { max: MAX_SLIP_LEGS }));
        }
      }}
    >
      <span aria-hidden="true" className={`odds-label truncate ${wide ? 'min-w-0' : 'w-full'}`}>
        {prefix !== null ? <b className="mr-1 opacity-60">{prefix}</b> : null}
        {label}
      </span>
      {enabled ? (
        <span aria-hidden="true" className="odds-price">
          {formatOddsMilli(live.oddsMilli)}
        </span>
      ) : (
        <LockIcon />
      )}
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

/** A padlock for a suspended or closed price (the market overlay says "Suspended"). */
function LockIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="currentColor"
      className="text-muted"
    >
      <path d="M8 1a3.5 3.5 0 0 0-3.5 3.5V6H4a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1h-.5V4.5A3.5 3.5 0 0 0 8 1Zm-2 3.5a2 2 0 1 1 4 0V6H6V4.5Z" />
    </svg>
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
