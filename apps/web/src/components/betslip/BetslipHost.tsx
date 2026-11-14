'use client';

import dynamic from 'next/dynamic';
import { useBetslip } from '@/providers/BetslipProvider';
import { BetslipButton } from './BetslipButton';

const loadDrawer = () => import('./BetslipDrawer');

// The drawer's code and text are only downloaded when the player first opens the slip.
const BetslipDrawer = dynamic(loadDrawer, { ssr: false });

/** Mounted once by the root layout: the floating button and the lazy drawer. */
export function BetslipHost() {
  const slip = useBetslip();
  return (
    <>
      <BetslipButton onIntent={() => void loadDrawer()} />
      {slip.isOpen ? <BetslipDrawer /> : null}
    </>
  );
}
