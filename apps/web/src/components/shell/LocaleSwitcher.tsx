'use client';

import { LAUNCHED_LOCALES, LOCALE_NAMES, type Locale } from '@vamos/i18n/locales';
import { useLocale, useSetLocale, useT } from '@/i18n/client';
import { api } from '@/lib/api/client';
import { useSession } from '@/providers/SessionProvider';

/** Language chips. Saves the cookie and, when signed in, the profile locale (used for SMS). */
export function LocaleSwitcher({ className = '' }: { className?: string }) {
  const t = useT();
  const locale = useLocale();
  const setLocale = useSetLocale();
  const session = useSession();

  const choose = (next: Locale) => {
    if (next === locale) return;
    setLocale(next);
    if (session.status === 'authenticated') {
      api.patch('/me', { locale: next }).catch(() => {
        // The cookie already switched the UI; the profile catches up next time.
      });
    }
  };

  return (
    <div role="group" aria-label={t('common.language.label')} className={`flex gap-2 ${className}`}>
      {LAUNCHED_LOCALES.map((code) => (
        <button
          key={code}
          type="button"
          lang={code}
          className="chip"
          aria-pressed={code === locale}
          aria-current={code === locale ? 'page' : undefined}
          onClick={() => choose(code)}
        >
          {LOCALE_NAMES[code]}
        </button>
      ))}
    </div>
  );
}
