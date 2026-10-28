import { getT } from '@/i18n/server';

/**
 * Permanent play-money notice while the platform runs in demo mode (see
 * CLAUDE.md); never hide or remove this banner.
 */
export async function DemoBanner() {
  const t = await getT();
  return (
    <p role="note" className="bg-demo-bg px-3 py-1 text-center text-xs font-semibold text-demo-ink">
      {t('common.demo.banner')}
    </p>
  );
}
