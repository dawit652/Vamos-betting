'use client';

import type { WalletTransaction } from '@vamos/contracts';
import type { MessageKey, MessageVars } from '@vamos/i18n/translate';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale, useT } from '@/i18n/client';
import { walletApi } from '@/lib/api/account';
import { newIdempotencyKey } from '@/lib/api/idempotency';
import { errorMessageKey, isApiClientError } from '@/lib/api/errors';
import { formatSantim } from '@/lib/format';
import { useSession } from '@/providers/SessionProvider';
import { formatDateTime } from './dates';
import { detailString, isExclusionError } from './errors';
import { accountPaths } from './paths';
import { Alert, Skeleton } from './ui';
import { usePagedList, type PagedList } from './usePagedList';
import {
  DEFAULT_DEMO_TOPUP,
  DEMO_TOPUP_AMOUNTS,
  TRANSACTION_LABEL,
  amountDirection,
  formatSignedSantim,
  formatWholeBirr,
} from './wallet';

interface Message {
  key: MessageKey;
  vars?: MessageVars;
  tone: 'error' | 'success';
}

function topUpError(error: unknown): Message {
  if (isApiClientError(error) && error.code === 'demo_balance_cap') {
    const cap = detailString(error, 'cap');
    const max = detailString(error, 'maxTopUp');
    return {
      key: 'account.wallet.topUp.cap',
      vars: { cap: formatSantim(cap), max: formatSantim(max) },
      tone: 'error',
    };
  }
  if (isApiClientError(error) && error.code === 'invalid_amount') {
    return { key: 'account.wallet.topUp.invalidAmount', tone: 'error' };
  }
  if (isExclusionError(error)) return { key: 'account.errors.coolingOff', tone: 'error' };
  return { key: errorMessageKey(error), tone: 'error' };
}

function DemoTopUp({ onDone }: { onDone: () => void }) {
  const t = useT();
  const session = useSession();
  const [amount, setAmount] = useState(DEFAULT_DEMO_TOPUP);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  // One key per intent (this amount); reused if the player retries after a failure.
  const key = useRef<string | null>(null);

  const choose = (value: string) => {
    if (value === amount) return;
    setAmount(value);
    key.current = null;
  };

  const submit = async () => {
    if (busy) return;
    key.current ??= newIdempotencyKey('topup');
    setBusy(true);
    setMessage(null);
    try {
      await walletApi.demoTopUp(amount, key.current);
      key.current = null;
      setMessage({
        key: 'account.wallet.topUp.done',
        vars: { amount: formatSantim(amount) },
        tone: 'success',
      });
      await session.refreshWallet();
      onDone();
    } catch (error) {
      // A definite refusal will not change on retry with the same key: start a new intent.
      if (isApiClientError(error) && error.status !== 0 && error.status < 500) key.current = null;
      setMessage(topUpError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card space-y-3">
      <h2 className="font-bold">{t('account.wallet.topUp.title')}</h2>
      <div
        role="radiogroup"
        aria-label={t('account.wallet.topUp.amount')}
        className="grid grid-cols-4 gap-2"
      >
        {DEMO_TOPUP_AMOUNTS.map((value) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={value === amount}
            className={`chip justify-center ${value === amount ? 'border-brand bg-brand text-brand-ink' : ''}`}
            onClick={() => choose(value)}
          >
            {formatWholeBirr(value)}
          </button>
        ))}
      </div>
      {message ? <Alert tone={message.tone}>{t(message.key, message.vars)}</Alert> : null}
      <button
        type="button"
        className="btn btn-accent w-full"
        disabled={busy}
        onClick={() => void submit()}
      >
        {busy
          ? t('common.actions.loading')
          : t('account.wallet.topUp.submit', { amount: formatSantim(amount) })}
      </button>
    </section>
  );
}

function TransactionRow({ tx }: { tx: WalletTransaction }) {
  const t = useT();
  const locale = useLocale();
  const direction = amountDirection(tx.amount);
  return (
    <li className="list-row flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="truncate font-semibold">{t(TRANSACTION_LABEL[tx.type])}</p>
        <p className="text-xxs text-muted">{formatDateTime(tx.createdAt, locale)}</p>
      </div>
      <div className="flex-none text-right tabular-nums">
        <p
          className={`font-bold ${
            direction === 'credit' ? 'text-up' : direction === 'debit' ? 'text-down' : ''
          }`}
        >
          {formatSignedSantim(tx.amount)}
        </p>
        <p className="text-xxs text-muted">
          {t('account.wallet.balanceAfter', { amount: formatSantim(tx.balanceAfter) })}
        </p>
      </div>
    </li>
  );
}

function Transactions({ list }: { list: PagedList<WalletTransaction> }) {
  const t = useT();
  return (
    <section className="space-y-2">
      <h2 className="px-3 font-bold">{t('account.wallet.transactions')}</h2>
      {list.loading ? (
        <Skeleton lines={4} />
      ) : (
        <>
          {list.error ? (
            <div className="space-y-2 px-3">
              <Alert>{t(errorMessageKey(list.error))}</Alert>
              <button
                type="button"
                className="btn btn-outline w-full"
                onClick={list.items.length === 0 ? list.reload : list.loadMore}
              >
                {t('common.actions.retry')}
              </button>
            </div>
          ) : null}
          {!list.error && list.items.length === 0 ? (
            <p className="card mx-3 text-center text-muted">{t('account.wallet.noTransactions')}</p>
          ) : null}
          {list.items.length > 0 ? (
            <ul className="overflow-hidden rounded-md border-t border-line">
              {list.items.map((tx) => (
                <TransactionRow key={tx.id} tx={tx} />
              ))}
            </ul>
          ) : null}
          {list.hasMore && !list.error ? (
            <div className="px-3">
              <button
                type="button"
                className="btn btn-outline w-full"
                disabled={list.loadingMore}
                onClick={list.loadMore}
              >
                {list.loadingMore ? t('common.actions.loading') : t('account.wallet.loadMore')}
              </button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

export function WalletView({ welcome }: { welcome: boolean }) {
  const t = useT();
  const session = useSession();
  const { refreshWallet } = session;
  const fetchPage = useCallback(
    (cursor: string | null, signal: AbortSignal) => walletApi.transactions(cursor, signal),
    [],
  );
  const list = usePagedList(fetchPage);

  // The header balance may be up to 30 s old: refresh it when the wallet opens.
  useEffect(() => {
    void refreshWallet();
  }, [refreshWallet]);

  const wallet = session.wallet;
  return (
    <div className="space-y-3">
      <div className="space-y-3 px-3">
        {welcome ? <Alert tone="success">{t('account.wallet.welcome')}</Alert> : null}
        <section className="card space-y-2 bg-brand text-brand-ink">
          <p className="text-xs opacity-80">{t('account.wallet.balance')}</p>
          <p className="text-2xl font-bold tabular-nums">
            <span className="mr-1 text-sm font-semibold opacity-80">ETB</span>
            {formatSantim(wallet?.cash)}
          </p>
          {wallet && wallet.bonus !== '0' ? (
            <p className="text-xs">
              {t('account.wallet.bonus')}: ETB {formatSantim(wallet.bonus)}
            </p>
          ) : null}
          {wallet?.demo !== false ? (
            <p className="text-xxs opacity-80">{t('account.wallet.playMoney')}</p>
          ) : null}
        </section>
        <div className="grid grid-cols-2 gap-2">
          <Link href={accountPaths.deposit} prefetch={false} className="btn btn-outline">
            {t('account.wallet.deposit')}
          </Link>
          <Link href={accountPaths.withdraw} prefetch={false} className="btn btn-outline">
            {t('account.wallet.withdraw')}
          </Link>
        </div>
        {wallet?.demo === true ? <DemoTopUp onDone={list.reload} /> : null}
      </div>
      <Transactions list={list} />
    </div>
  );
}
