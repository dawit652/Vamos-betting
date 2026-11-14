import { getT } from '@/i18n/server';
import { isDemoMode } from '@/lib/api/mode';

/**
 * Play-money notice on every page while the API runs in demo mode. It goes away
 * only when the API reports licensed mode (getOperatingMode, which shows it
 * whenever the mode is unknown). Never hide it any other way.
 */
export async function DemoBanner() {
  const [t, demo] = await Promise.all([getT(), isDemoMode()]);
  if (!demo) return null;
  return (
    <p
      role="note"
      className="border-b border-line bg-demo-bg px-3 py-1 text-center text-xs font-semibold text-demo-ink"
    >
      {t('common.demo.banner')}
    </p>
  );
}
