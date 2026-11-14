'use client';

import dynamic from 'next/dynamic';
import { useSyncExternalStore } from 'react';

/** The `lg` breakpoint: from here up the betslip is a column, not a drawer. */
const WIDE = '(min-width: 64rem)';

// Phones never download the panel (code or text) here; they get it with the drawer, on first open.
const DockedBetslip = dynamic(() => import('./BetslipDrawer').then((m) => m.DockedBetslip), {
  ssr: false,
});

function subscribe(onChange: () => void): () => void {
  const query = window.matchMedia(WIDE);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/**
 * The betslip docked in the right column of a wide sportsbook page
 * (SportsbookFrame): always in view, so picks land in it without a tap.
 * Renders nothing on a narrow screen, where the slip bar opens the drawer.
 */
export function BetslipDock() {
  const wide = useSyncExternalStore(
    subscribe,
    () => window.matchMedia(WIDE).matches,
    () => false,
  );
  if (!wide) return null;
  return (
    <section
      aria-labelledby="betslip-dock-title"
      className="panel flex max-h-[inherit] flex-col bg-page"
    >
      <DockedBetslip titleId="betslip-dock-title" />
    </section>
  );
}
