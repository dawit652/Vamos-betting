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
import { MOVE_MS, activeMove, advanceMove, initialMove, type OddsMove } from './odds-move';
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
  const name = localName(selection.label, locale);
  const label = layout === 'row' ? shortLabel(selection.code) : name;
  const move = usePriceMove(live.oddsMilli);
  const showMove = enabled ? move : null;
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
  // aria-label replaces the button's content as its name, so the move is part of it.
  const ariaLabel = enabled
    ? `${t('sportsbook.markets.oddsLabel', { ...described, odds: formatOddsMilli(live.oddsMilli) })}${
        showMove === null ? '' : `, ${t(`common.oddsMove.${showMove}`)}`
      }`
    : t('sportsbook.markets.oddsLabelSuspended', described);

  return (
    <button
      type="button"
      className="odds-btn relative px-1"
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
      <span aria-hidden="true" className="odds-label w-full truncate">
        {label}
      </span>
      {enabled ? <span aria-hidden="true">{formatOddsMilli(live.oddsMilli)}</span> : <LockIcon />}
      {showMove !== null ? (
        <>
          <span
            key={live.oddsMilli}
            aria-hidden="true"
            className={`${styles.flash} ${showMove === 'up' ? styles.flashUp : styles.flashDown}`}
          />
          <span
            aria-hidden="true"
            className={`absolute top-0.5 right-0.5 text-[0.5rem] leading-none ${
              showMove === 'up' ? 'text-up' : 'text-down'
            }`}
          >
            {showMove === 'up' ? '▲' : '▼'}
          </span>
        </>
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

/**
 * Direction of the last price change, for MOVE_MS. The first value is a
 * baseline; each button keeps its own state, so only the button whose price
 * moved re-renders when the arrow appears or expires.
 */
function usePriceMove(oddsMilli: number): OddsMove | null {
  const state = useRef(initialMove(oddsMilli));
  const [move, setMove] = useState<OddsMove | null>(null);
  useEffect(() => {
    if (oddsMilli === state.current.oddsMilli) return;
    const now = Date.now();
    state.current = advanceMove(state.current, oddsMilli, now);
    setMove(activeMove(state.current, now));
    const timer = setTimeout(() => setMove(activeMove(state.current, Date.now())), MOVE_MS);
    return () => clearTimeout(timer);
  }, [oddsMilli]);
  return move;
}
