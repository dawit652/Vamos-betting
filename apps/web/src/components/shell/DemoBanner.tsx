import { getT } from '@/i18n/server';
import { IS_DEMO } from '@/lib/mode';

/**
 * Permanent play-money notice while the platform runs in demo mode (see
 * CLAUDE.md); never hide or remove it in a demo. A licensed (real money) build shows nothing.
 */
export async function DemoBanner() {
  if (!IS_DEMO) return null;
  const t = await getT();
  return (
    <p role="note" className="bg-demo-bg px-3 py-1 text-center text-xs font-semibold text-demo-ink">
      {t('common.demo.banner')}
    </p>
  );
}
