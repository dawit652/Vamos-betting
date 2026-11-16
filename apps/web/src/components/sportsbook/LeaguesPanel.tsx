'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useT } from '@/i18n/client';
import { TelegramLink } from '@/components/shell/TelegramLink';
import type { Sport } from '@/lib/routes';
import { LeagueIcon } from './LeagueIcon';
import type { PanelData, PanelLeague } from './panel';

/**
 * The phone league panel (opened by LeaguesDrawer, which loads this file only then): a modal
 * panel from the left with the rows of /leagues-panel, the same leagues as the desktop column.
 */
export default function LeaguesPanel({
  sport,
  competition,
  titleId,
  onClose,
}: {
  sport: Sport;
  competition?: string;
  titleId: string;
  onClose: () => void;
}) {
  const t = useT();
  const [data, setData] = useState<PanelData | null>(null);
  const [failed, setFailed] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const close = onClose;

  useEffect(() => {
    if (data !== null || failed) return;
    let live = true;
    fetch(`/leagues-panel?sport=${sport}`, { credentials: 'same-origin' })
      .then((res) => (res.ok ? (res.json() as Promise<PanelData>) : Promise.reject(new Error())))
      .then(
        (rows) => live && setData(rows),
        () => live && setFailed(true),
      );
    return () => {
      live = false;
    };
  }, [data, failed, sport]);

  useEffect(() => {
    panelRef.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close();
        return;
      }
      if (event.key !== 'Tab' || panelRef.current === null) return;
      // Keep Tab inside the panel while it is modal.
      const items = panelRef.current.querySelectorAll<HTMLElement>('a[href], button');
      const first = items[0];
      const last = items[items.length - 1];
      if (first === undefined || last === undefined) return;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === panelRef.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = overflow;
      window.removeEventListener('keydown', onKey);
    };
  }, [close]);

  const row = (c: PanelLeague) => (
    <Link
      key={c.slug}
      href={c.href}
      prefetch={false}
      aria-current={c.slug === competition ? 'page' : undefined}
      className="leagues-row"
      onClick={close}
    >
      <LeagueIcon flag={c.flag} badge={c.badge} />
      <span className="min-w-0 flex-1 truncate">{c.name}</span>
      <span className="text-xxs tabular-nums opacity-70">{c.count}</span>
    </Link>
  );

  return (
    <div className="fixed inset-0 z-50">
      <button
        type="button"
        tabIndex={-1}
        aria-label={t('common.actions.close')}
        className="absolute inset-0 bg-black/45"
        onClick={close}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="leagues-panel"
      >
        <div className="flex items-center gap-2 border-b border-line px-3 py-2">
          <h2 id={titleId} className="min-w-0 flex-1 truncate text-sm font-extrabold">
            {t('sportsbook.leagues.topLeagues')}
          </h2>
          <button
            type="button"
            aria-label={t('common.actions.close')}
            className="flex h-8 w-8 flex-none items-center justify-center rounded-full border border-line"
            onClick={close}
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
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
          {data === null ? (
            failed ? (
              <button type="button" className="leagues-row" onClick={() => setFailed(false)}>
                {t('common.actions.retry')}
              </button>
            ) : (
              <p className="p-3 text-xs text-muted">{t('common.actions.loading')}</p>
            )
          ) : (
            <>
              {data.featured.length > 0 ? (
                // The panel's title already says "Top leagues": no second heading here.
                <nav aria-label={t('sportsbook.leagues.topLeagues')}>{data.featured.map(row)}</nav>
              ) : null}
              {data.featured.length === 0 ? (
                <p className="p-3 text-xs text-muted">{t('sportsbook.leagues.empty')}</p>
              ) : null}
            </>
          )}
        </div>
        {data?.telegram ? (
          <div className="border-t border-line p-3 text-sm">
            <TelegramLink href={data.telegram} label={t('common.telegram.join')} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
