'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useT } from '@/i18n/client';
import { routes, sportFromPath, SPORTS } from '@/lib/routes';

/** Sport chips under the header, shown on the sport and live lists only. */
export function SportChips() {
  const t = useT();
  const current = sportFromPath(usePathname());
  if (current === null) return null;
  return (
    <nav
      aria-label={t('common.nav.sports')}
      className="no-scrollbar mx-auto flex max-w-2xl gap-2 overflow-x-auto px-3 py-2"
    >
      {SPORTS.map((sport) => (
        <Link
          key={sport}
          href={current.live ? routes.live(sport) : routes.sport(sport)}
          className="chip"
          aria-current={sport === current.sport ? 'page' : undefined}
        >
          {t(`common.sports.${sport}`)}
        </Link>
      ))}
    </nav>
  );
}
