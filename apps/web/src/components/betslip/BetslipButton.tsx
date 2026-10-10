'use client';

import { useT } from '@/i18n/client';
import { useBetslip } from '@/providers/BetslipProvider';

/** Floating yellow button above the bottom nav; opens the betslip drawer. */
export function BetslipButton({ onIntent }: { onIntent?: () => void }) {
  const t = useT();
  const slip = useBetslip();
  if (!slip.hydrated || slip.count === 0 || slip.isOpen) return null;
  return (
    <button
      type="button"
      onClick={slip.open}
      onPointerEnter={onIntent}
      onTouchStart={onIntent}
      aria-label={`${t('common.betslip.button')}: ${t('common.betslip.count', { count: slip.count })}`}
      className="fixed right-3 bottom-[calc(var(--spacing-bottom-nav)+env(safe-area-inset-bottom)+0.75rem)] z-40 flex items-center gap-2 rounded-full bg-accent py-2 pr-2 pl-4 font-bold text-accent-ink shadow-lg"
    >
      {t('common.betslip.button')}
      <span className="flex h-7 min-w-7 items-center justify-center rounded-full bg-brand px-1 text-sm text-brand-ink tabular-nums">
        {slip.count}
      </span>
    </button>
  );
}
