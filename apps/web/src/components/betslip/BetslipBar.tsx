'use client';

import { useT } from '@/i18n/client';
import { useBetslip } from '@/providers/BetslipProvider';
import { miniBarVisible, miniBarView } from './bar-model';
import { useSlipQuote } from './useSlipQuote';

/**
 * Full-width mini slip bar above the bottom nav; tapping it opens the drawer.
 * The quote hook only runs while the bar is on screen (the drawer runs its own
 * while open), so there is never more than one quote request per change.
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
      <div aria-hidden="true" className="h-14" />
      <button
        type="button"
        onClick={slip.open}
        onPointerEnter={onIntent}
        onTouchStart={onIntent}
        aria-label={`${t('common.betslip.button')}: ${t('common.betslip.count', { count: view.count })}`}
        className="fixed right-0 bottom-[calc(var(--spacing-bottom-nav)+env(safe-area-inset-bottom))] left-0 z-40 flex items-center gap-3 bg-accent px-3 py-2 text-left font-bold text-accent-ink shadow-lg"
      >
        <span className="flex h-7 min-w-7 items-center justify-center rounded-full bg-brand px-1 text-sm text-brand-ink tabular-nums">
          {view.count}
        </span>
        <span className="flex-1 text-sm">{t('common.betslip.button')}</span>
        <span className="flex flex-col items-end text-xs leading-tight tabular-nums">
          <span className="font-semibold opacity-80">
            {t('common.betslip.odds')} {view.totalOdds}
          </span>
          <span>
            {t('common.betslip.netPay')} {view.netPay}
          </span>
        </span>
      </button>
    </>
  );
}
