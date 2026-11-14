'use client';

import { productOddsMilli } from '@vamos/core';
import { useT } from '@/i18n/client';
import { formatTotalOdds } from '@/lib/format';
import { useBetslip } from '@/providers/BetslipProvider';

/**
 * The slip bar above the bottom nav: how many picks are on the slip and their
 * combined odds; a tap opens the betslip drawer. Hidden while the slip is empty
 * or open, and on wide sportsbook pages, where the slip is docked (`.slip-bar`
 * in globals.css).
 */
export function BetslipButton({ onIntent }: { onIntent?: () => void }) {
  const t = useT();
  const slip = useBetslip();
  if (!slip.hydrated || slip.count === 0 || slip.isOpen) return null;
  const totalOdds = productOddsMilli(slip.legs.map((leg) => leg.oddsMilli)).toString();
  return (
    <button
      type="button"
      onClick={slip.open}
      onPointerEnter={onIntent}
      onTouchStart={onIntent}
      aria-label={`${t('common.betslip.button')}: ${t('common.betslip.count', { count: slip.count })}`}
      className="slip-bar btn-accent fixed inset-x-3 bottom-[calc(var(--spacing-bottom-nav)+env(safe-area-inset-bottom)+0.5rem)] z-40 mx-auto flex max-w-xl items-center gap-2.5 rounded-2xl py-2 pr-3 pl-2 text-left shadow-xl shadow-black/40 lg:bottom-4"
    >
      <span className="flex h-8 min-w-8 items-center justify-center rounded-xl bg-accent-ink px-1.5 text-sm font-extrabold text-accent tabular-nums">
        {slip.count}
      </span>
      <span className="text-base font-extrabold">{t('common.betslip.button')}</span>
      <span className="ml-auto text-right leading-tight">
        <span className="block text-xxs font-semibold opacity-70">
          {t('sportsbook.betslip.totalOdds')}
        </span>
        <span className="block font-extrabold tabular-nums">{formatTotalOdds(totalOdds)}</span>
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
  );
}
