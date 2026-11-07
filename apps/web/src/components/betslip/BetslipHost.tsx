'use client';

import dynamic from 'next/dynamic';
import { useBetslip } from '@/providers/BetslipProvider';
import { BetslipBar } from './BetslipBar';

const loadDrawer = () => import('./BetslipDrawer');

// The drawer's code is only downloaded when the player first opens the slip.
const BetslipDrawer = dynamic(loadDrawer, { ssr: false });

/** Mounted once by the root layout: the mini slip bar and the lazy drawer. */
export function BetslipHost() {
  const slip = useBetslip();
  return (
    <>
      <BetslipBar onIntent={() => void loadDrawer()} />
      {slip.isOpen ? <BetslipDrawer /> : null}
    </>
  );
}
