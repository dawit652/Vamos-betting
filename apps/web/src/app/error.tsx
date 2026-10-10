'use client';

import { useEffect } from 'react';
import { useT } from '@/i18n/client';
import { errorMessageKey } from '@/lib/api/errors';

/** Fallback for an error thrown while rendering a page (e.g. the API is down). */
export default function ErrorPage({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  const t = useT();
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <section role="alert" className="card m-3 space-y-3 text-center">
      <p className="font-semibold">{t(errorMessageKey(error))}</p>
      <button type="button" className="btn btn-accent" onClick={() => retry()}>
        {t('common.actions.retry')}
      </button>
    </section>
  );
}
