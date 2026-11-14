import { getT } from '@/i18n/server';
import { isDemoMode } from '@/lib/api/mode';

/**
 * The play-money notice: on every page for as long as the platform runs in demo
 * mode, which is until an ELS licence exists (see CLAUDE.md). It follows the
 * mode the API reports and is gone only in licensed mode, where money is real;
 * never hide or remove it in demo mode.
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
