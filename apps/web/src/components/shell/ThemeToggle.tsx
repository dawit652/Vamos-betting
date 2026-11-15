'use client';

import { useState } from 'react';
import { useT } from '@/i18n/client';
import { LOCALE_COOKIE_MAX_AGE, THEME_COLORS, THEME_COOKIE, type Theme } from '@/lib/cookies';

/**
 * Dark / light switch: in the header from the `sm` breakpoint up, in the footer on phones
 * (the header has no room for it at 360 px). The choice is the `vamos_theme` cookie, which the
 * root layout reads to render `<html data-theme>`, so a reload never flashes the other theme.
 */
export function ThemeToggle({
  initial,
  className = 'border-white/20 text-chrome-ink',
}: {
  initial: Theme;
  /** Border and text colours; the default suits the header. */
  className?: string;
}) {
  const t = useT();
  const [theme, setTheme] = useState(initial);
  const next: Theme = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      className={`flex h-8 w-8 flex-none items-center justify-center rounded-full border ${className}`}
      aria-label={t(next === 'light' ? 'common.theme.toLight' : 'common.theme.toDark')}
      onClick={() => {
        document.documentElement.dataset.theme = next;
        document
          .querySelector('meta[name="theme-color"]')
          ?.setAttribute('content', THEME_COLORS[next]);
        document.cookie = `${THEME_COOKIE}=${next}; path=/; max-age=${LOCALE_COOKIE_MAX_AGE}; samesite=lax`;
        setTheme(next);
      }}
    >
      <svg
        viewBox="0 0 24 24"
        width="16"
        height="16"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {theme === 'dark' ? (
          <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z" />
        ) : (
          <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />
        )}
      </svg>
    </button>
  );
}
