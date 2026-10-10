'use client';

import { LAUNCHED_LOCALES, LOCALE_NAMES, type Locale } from '@vamos/i18n/locales';
import { useLocale, useSetLocale, useT } from '@/i18n/client';
import { api } from '@/lib/api/client';
import { useSession } from '@/providers/SessionProvider';

/** Switches the UI language: the cookie and, when signed in, the profile locale (used for SMS). */
function useChooseLocale(): (next: Locale) => void {
  const locale = useLocale();
  const setLocale = useSetLocale();
  const session = useSession();
  return (next: Locale) => {
    if (next === locale) return;
    setLocale(next);
    if (session.status === 'authenticated') {
      api.patch('/me', { locale: next }).catch(() => {
        // The cookie already switched the UI; the profile catches up next time.
      });
    }
  };
}

/** Language chips (footer, account page). */
export function LocaleSwitcher({ className = '' }: { className?: string }) {
  const t = useT();
  const locale = useLocale();
  const choose = useChooseLocale();

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

/** Two-letter label of a language for the compact header toggle. */
const SHORT_NAMES: Partial<Record<Locale, string>> = { am: 'አማ', en: 'EN' };

/**
 * The header's compact language toggle: one tap to the other launched
 * language, so a visitor who does not read Amharic finds it without
 * scrolling to the footer.
 */
export function LocaleToggle() {
  const t = useT();
  const locale = useLocale();
  const choose = useChooseLocale();
  const other = LAUNCHED_LOCALES.find((code) => code !== locale) ?? LAUNCHED_LOCALES[0];
  if (other === undefined) return null;
  return (
    <button
      type="button"
      lang={other}
      className="rounded border border-white/40 px-1.5 py-1 text-xs font-bold"
      aria-label={t('common.language.switchTo', { language: LOCALE_NAMES[other] })}
      onClick={() => choose(other)}
    >
      {SHORT_NAMES[other] ?? other.toUpperCase()}
    </button>
  );
}
