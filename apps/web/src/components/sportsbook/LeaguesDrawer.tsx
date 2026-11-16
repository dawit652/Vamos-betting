'use client';

import dynamic from 'next/dynamic';
import { useCallback, useId, useRef, useState } from 'react';
import { useT } from '@/i18n/client';
import type { Sport } from '@/lib/routes';

// The panel's code is fetched when it is first opened, not with the page (page-weight budget).
const LeaguesPanel = dynamic(() => import('./LeaguesPanel'), { ssr: false });

/**
 * Phones only (hidden from `lg`, where the left column shows the same leagues): the button at
 * the left edge of the sport rail that opens the league panel (LeaguesPanel), minimized by
 * default. Its rows are fetched from /leagues-panel on first open. The frame keys it by sport,
 * so another sport starts with its own rows.
 */
export function LeaguesDrawer({ sport, competition }: { sport: Sport; competition?: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const titleId = useId();

  const close = useCallback(() => {
    setOpen(false);
    buttonRef.current?.focus();
  }, []);

  return (
    <div className="flex-none pl-3 lg:hidden">
      <button
        ref={buttonRef}
        type="button"
        className="leagues-btn"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        <svg
          viewBox="0 0 24 24"
          width="16"
          height="16"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
        >
          <path d="M4 6h16M4 12h16M4 18h10" />
        </svg>
        {t('sportsbook.leagues.topLeagues')}
      </button>
      <div id={panelId} hidden={!open}>
        {open ? (
          <LeaguesPanel sport={sport} competition={competition} titleId={titleId} onClose={close} />
        ) : null}
      </div>
    </div>
  );
}
