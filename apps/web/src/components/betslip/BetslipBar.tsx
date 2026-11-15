'use client';

import { useT } from '@/i18n/client';
import { useBetslip } from '@/providers/BetslipProvider';
import { miniBarVisible, miniBarView } from './bar-model';
import { useSlipQuote } from './useSlipQuote';

/**
 * Mini slip bar floating above the bottom nav: pick count, total odds and net
 * pay; tapping it opens the drawer. The quote hook only runs while the bar is on
 * screen (the drawer runs its own while open), so there is never more than one
 * quote request per change. On wide sportsbook pages the betslip is docked
 * instead, and `.slip-bar` (globals.css) hides the bar and its spacer.
 */
export function BetslipBar({ onIntent }: { onIntent?: () => void }) {
  const slip = useBetslip();
  if (!miniBarVisible(slip)) return null;
  return <Bar onIntent={onIntent} />;
}

function Bar({ onIntent }: { onIntent?: () => void }) {
  const t = useT();
  const slip = useBetslip();
  const { quote } = useSlipQuote(slip.legs, slip.stake, slip.updateOdds);
  const view = miniBarView({
    hydrated: slip.hydrated,
    count: slip.count,
    isOpen: slip.isOpen,
    quote,
  });
  if (view === null) return null;
  return (
    <>
      {/* Room at the end of the page so the fixed bar never covers its last content. */}
      <div aria-hidden="true" className="slip-bar h-16" />
      <button
        type="button"
        onClick={slip.open}
        onPointerEnter={onIntent}
        onTouchStart={onIntent}
        aria-label={`${t('common.betslip.button')}: ${t('common.betslip.count', { count: view.count })}`}
        className="slip-bar btn-accent fixed inset-x-3 bottom-[calc(var(--spacing-bottom-nav)+env(safe-area-inset-bottom)+0.5rem)] z-40 mx-auto flex max-w-xl items-center gap-2.5 rounded-2xl py-2 pr-3 pl-2 text-left shadow-lg lg:bottom-4"
      >
        <span className="flex h-8 min-w-8 items-center justify-center rounded-xl bg-accent-ink px-1.5 text-sm font-extrabold text-accent tabular-nums">
          {view.count}
        </span>
        <span className="flex-1 text-base font-extrabold">{t('common.betslip.button')}</span>
        <span className="flex flex-col items-end text-xs leading-tight tabular-nums">
          <span className="font-semibold opacity-70">
            {t('common.betslip.odds')} {view.totalOdds}
          </span>
          <span className="font-extrabold">
            {t('common.betslip.netPay')} {view.netPay}
          </span>
        </span>
        <svg
          viewBox="0 0 24 24"
          width="18"
          height="18"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m6 15 6-6 6 6" />
        </svg>
      </button>
    </>
  );
}
