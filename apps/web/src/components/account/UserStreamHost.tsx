'use client';

import { useEffect, useRef, useState } from 'react';
import { useT } from '@/i18n/client';
import { createThrottle } from '@/lib/cashout/throttle';
import { describeUserMessage, type UserToast } from '@/lib/user-stream/messages';
import { onToast, wasAnnounced } from '@/lib/user-stream/toast-bus';
import { useUserStream } from '@/lib/user-stream/useUserStream';
import { useSession } from '@/providers/SessionProvider';

/**
 * Mounted once by the account layout (not by the shell, so the home page does
 * not load the stream code): listens to the player's push stream while any
 * account page is open, shows a toast for bets settled, cashed out, accepted
 * or rejected, and refreshes the balance chip when the wallet changes.
 */

const TOAST_MS = 6_000;
const MAX_TOASTS = 3;
const WALLET_REFRESH_MS = 1_000;

interface Shown extends UserToast {
  id: number;
}

const TONE_CLASS: Record<UserToast['tone'], string> = {
  success: 'border-up/50 bg-surface text-ink',
  info: 'border-line bg-surface text-ink',
  error: 'border-down/50 bg-surface text-down',
};

export function UserStreamHost() {
  const t = useT();
  const { refreshWallet } = useSession();
  const [toasts, setToasts] = useState<Shown[]>([]);
  const nextId = useRef(0);

  const walletRefresh = useRef<ReturnType<typeof createThrottle> | null>(null);
  useEffect(() => {
    const throttle = createThrottle(() => refreshWallet(), WALLET_REFRESH_MS);
    walletRefresh.current = throttle;
    return () => {
      throttle.cancel();
      walletRefresh.current = null;
    };
  }, [refreshWallet]);

  const show = useRef((toast: UserToast) => {
    const id = nextId.current++;
    setToasts((current) => [...current.slice(-(MAX_TOASTS - 1)), { ...toast, id }]);
    setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), TOAST_MS);
  });
  useEffect(() => onToast((toast) => show.current(toast)), []);

  useUserStream(
    (message) => {
      const effect = describeUserMessage(message);
      if (effect.refreshWallet) walletRefresh.current?.request();
      if (effect.toast === null) return;
      // The cash-out sheet already announced its own result.
      if (message.type === 'bet.cashed_out' && wasAnnounced(message.data.betId)) return;
      show.current(effect.toast);
    },
    () => walletRefresh.current?.request(),
  );

  if (toasts.length === 0) return null;
  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-[calc(var(--spacing-bottom-nav)+env(safe-area-inset-bottom)+0.75rem)] z-[60] mx-auto flex max-w-md flex-col gap-2 px-3"
      role="region"
      aria-live="polite"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role="status"
          className={`pointer-events-auto flex items-start gap-2 rounded border px-3 py-2 text-sm font-semibold shadow-lg ${TONE_CLASS[toast.tone]}`}
        >
          <p className="min-w-0 flex-1">{t(toast.key, toast.params)}</p>
          <button
            type="button"
            className="flex-none px-1 text-lg leading-none text-muted"
            aria-label={t('account.notify.dismiss')}
            onClick={() => setToasts((current) => current.filter((item) => item.id !== toast.id))}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
