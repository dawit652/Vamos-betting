'use client';

import type {
  DepositView as Deposit,
  PaymentOptionsResponse,
  PaymentProviderName,
} from '@vamos/contracts';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { formatDateTime } from '@/components/account/dates';
import { type Message } from '@/components/account/errors';
import { Alert, Chip, Field, Skeleton, describedBy } from '@/components/account/ui';
import { formatWholeBirr } from '@/components/account/wallet';
import { useLocale, useT } from '@/i18n/client';
import { newIdempotencyKey } from '@/lib/api/idempotency';
import { isApiClientError } from '@/lib/api/errors';
import { paymentsApi } from '@/lib/api/payments';
import { formatSantim } from '@/lib/format';
import { routes } from '@/lib/routes';
import { useSession } from '@/providers/SessionProvider';
import { PaymentDemoNotice, PhoneReadOnly, ProviderField, usePaymentOptions } from './PaymentParts';
import { TransferPanel } from './TransferPanel';
import {
  AMOUNT_ERROR_KEY,
  DEPOSIT_POLL_LIMIT_MS,
  DEPOSIT_QUICK_AMOUNTS,
  DEPOSIT_STATUS_LABEL,
  checkAmount,
  createIntentKeys,
  depositFailureKey,
  depositPollDelayMs,
  depositTone,
  isDefiniteRefusal,
  isDepositFinal,
  paymentErrorMessage,
  pickProvider,
} from './payments';

// Module level so the key outlives the form: a retry after a timeout reuses it.
const depositKeys = createIntentKeys(newIdempotencyKey, 'deposit');

/** Polls one deposit until it is final, then refreshes the balance. */
function useDepositPolling(
  initial: Deposit | null,
  onFinal: (deposit: Deposit) => void,
): {
  deposit: Deposit | null;
  setDeposit: (d: Deposit | null) => void;
  stopped: boolean;
  recheck: () => void;
} {
  const [deposit, setDeposit] = useState<Deposit | null>(initial);
  const [stopped, setStopped] = useState(false);
  const [round, setRound] = useState(0);
  const onFinalRef = useRef(onFinal);
  useEffect(() => {
    onFinalRef.current = onFinal;
  }, [onFinal]);

  const id = deposit?.id ?? null;
  const open = deposit !== null && !isDepositFinal(deposit.status);
  useEffect(() => {
    if (id === null || !open) return;
    const controller = new AbortController();
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    const tick = () => {
      if (Date.now() - startedAt > DEPOSIT_POLL_LIMIT_MS) {
        setStopped(true);
        return;
      }
      paymentsApi
        .deposit(id, controller.signal)
        .then((next) => {
          if (controller.signal.aborted) return;
          setDeposit(next);
          if (isDepositFinal(next.status)) {
            onFinalRef.current(next);
            return;
          }
          timer = setTimeout(tick, depositPollDelayMs(++attempt));
        })
        .catch(() => {
          // A failed poll (network, 5xx) is retried; only a stopped page ends it.
          if (!controller.signal.aborted) timer = setTimeout(tick, depositPollDelayMs(++attempt));
        });
    };
    timer = setTimeout(tick, depositPollDelayMs(0));
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [id, open, round]);

  return {
    deposit,
    setDeposit: (d) => {
      setStopped(false);
      setDeposit(d);
    },
    stopped,
    recheck: () => {
      setStopped(false);
      setRound((n) => n + 1);
    },
  };
}

function DepositProgress({
  deposit,
  options,
  stopped,
  onRecheck,
  onAnother,
  onDeposit,
}: {
  deposit: Deposit;
  options: PaymentOptionsResponse;
  stopped: boolean;
  onRecheck: () => void;
  onAnother: () => void;
  onDeposit: (deposit: Deposit) => void;
}) {
  const demo = options.demo;
  const transfer = deposit.initiation?.kind === 'transfer' && options.smsRail !== null;
  const t = useT();
  const final = isDepositFinal(deposit.status);
  const instructions = deposit.initiation?.instructions ?? null;
  const redirectUrl = deposit.initiation?.redirectUrl ?? null;
  return (
    <section className="card space-y-3" aria-live="polite">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-bold">ETB {formatSantim(deposit.amount)}</h2>
        <Chip tone={depositTone(deposit.status)}>{t(DEPOSIT_STATUS_LABEL[deposit.status])}</Chip>
      </div>
      {deposit.status === 'succeeded' ? (
        <Alert tone="success">
          {t('account.payments.deposit.succeeded', { amount: formatSantim(deposit.amount) })}
        </Alert>
      ) : null}
      {deposit.status === 'failed' || deposit.status === 'expired' ? (
        <Alert>{t(depositFailureKey(deposit))}</Alert>
      ) : null}
      {deposit.underReview ? (
        <Alert tone="info">{t('account.payments.deposit.underReview')}</Alert>
      ) : null}
      {!final && transfer && options.smsRail !== null ? (
        <TransferPanel deposit={deposit} rail={options.smsRail} demo={demo} onDeposit={onDeposit} />
      ) : null}
      {!final ? (
        <>
          {transfer ? null : <p>{instructions ?? t('account.payments.deposit.pushFallback')}</p>}
          {redirectUrl !== null ? (
            <a href={redirectUrl} className="btn btn-accent w-full" rel="noreferrer">
              {t('account.payments.deposit.openCheckout')}
            </a>
          ) : null}
          <p className="text-muted">
            {stopped
              ? t('account.payments.deposit.stopped')
              : t('account.payments.deposit.waiting')}
          </p>
          {stopped ? (
            <button type="button" className="btn btn-outline w-full" onClick={onRecheck}>
              {t('account.payments.deposit.checkAgain')}
            </button>
          ) : null}
          {demo && deposit.provider === 'mock' ? (
            <p className="text-muted">
              {t('account.payments.deposit.simulatorHint')}{' '}
              <Link
                href={routes.devPhone}
                target="_blank"
                className="font-semibold text-brand underline"
              >
                {t('account.payments.deposit.openSimulator')}
              </Link>
            </p>
          ) : null}
          <p className="text-xxs text-muted">{t('account.payments.deposit.lateNote')}</p>
        </>
      ) : (
        <button type="button" className="btn btn-outline w-full" onClick={onAnother}>
          {t('account.payments.deposit.another')}
        </button>
      )}
    </section>
  );
}

function DepositForm({
  options,
  onCreated,
}: {
  options: PaymentOptionsResponse;
  onCreated: (deposit: Deposit) => void;
}) {
  const t = useT();
  const { me } = useSession();
  const providers = options.providers.filter((p) => p.deposits).map((p) => p.name);
  const defaultProvider = pickProvider(options, 'deposits');
  const [provider, setProvider] = useState<PaymentProviderName | null>(defaultProvider);
  // SMS rail: the institution the player pays through; the server picks an account within it.
  const methods = options.smsRail?.methods ?? [];
  const [institution, setInstitution] = useState<string | null>(methods[0]?.institution ?? null);
  const [input, setInput] = useState(formatWholeBirr(DEPOSIT_QUICK_AMOUNTS[1] ?? '10000'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Message | null>(null);
  const [amountError, setAmountError] = useState<string | undefined>();

  if (provider === null) {
    return <Alert tone="info">{t('account.payments.notAvailableForYou')}</Alert>;
  }

  const submit = async () => {
    if (busy) return;
    const checked = checkAmount(input, options.limits.minDeposit, options.limits.maxDeposit);
    if (!checked.ok) {
      setAmountError(
        t(AMOUNT_ERROR_KEY[checked.reason], {
          min: formatSantim(options.limits.minDeposit),
          max: formatSantim(options.limits.maxDeposit),
        }),
      );
      return;
    }
    setAmountError(undefined);
    setError(null);
    setBusy(true);
    const chosen = provider === 'sms' && institution !== null ? institution : undefined;
    const key = depositKeys.get(`${provider}:${chosen ?? ''}:${checked.amount}`);
    try {
      const deposit = await paymentsApi.createDeposit(
        {
          amount: checked.amount,
          provider,
          ...(chosen === undefined ? {} : { institution: chosen }),
        },
        key,
      );
      depositKeys.clear();
      onCreated(deposit);
    } catch (e) {
      // A definite refusal never changes with the same key: the next try is a new intent.
      if (isDefiniteRefusal(e)) depositKeys.clear();
      setError(paymentErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const checked = checkAmount(input, options.limits.minDeposit, options.limits.maxDeposit);
  return (
    <form
      className="card space-y-3"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <p className="text-muted">{t('account.payments.deposit.intro')}</p>
      <div
        role="group"
        aria-label={t('account.payments.deposit.quick')}
        className="grid grid-cols-4 gap-2"
      >
        {DEPOSIT_QUICK_AMOUNTS.map((value) => {
          const selected = checked.ok && checked.amount === value;
          return (
            <button
              key={value}
              type="button"
              aria-pressed={selected}
              className={`chip justify-center ${selected ? 'border-brand bg-brand text-brand-ink' : ''}`}
              onClick={() => {
                setInput(formatWholeBirr(value));
                setAmountError(undefined);
              }}
            >
              {formatWholeBirr(value)}
            </button>
          );
        })}
      </div>
      <Field
        id="deposit-amount"
        label={t('account.payments.amount')}
        hint={t('account.payments.deposit.limits', {
          min: formatSantim(options.limits.minDeposit),
          max: formatSantim(options.limits.maxDeposit),
        })}
        error={amountError}
      >
        <input
          id="deposit-amount"
          className="input tabular-nums"
          inputMode="decimal"
          autoComplete="off"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          {...describedBy('deposit-amount', amountError, true)}
        />
      </Field>
      {provider === 'sms' ? null : (
        <Field
          id="deposit-phone"
          label={t('account.payments.phone')}
          hint={t('account.payments.deposit.phoneHint')}
        >
          <PhoneReadOnly id="deposit-phone" phone={me?.phone ?? ''} />
        </Field>
      )}
      <Field id="deposit-provider" label={t('account.payments.provider')}>
        <ProviderField
          id="deposit-provider"
          providers={providers}
          value={provider}
          onChange={setProvider}
        />
      </Field>
      {provider === 'sms' && methods.length > 1 ? (
        <Field id="deposit-institution" label={t('account.payments.deposit.transfer.payWith')}>
          <select
            id="deposit-institution"
            className="input"
            value={institution ?? ''}
            onChange={(event) => setInstitution(event.target.value)}
          >
            {methods.map((m) => (
              <option key={m.institution} value={m.institution}>
                {m.name}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      {error ? <Alert>{t(error.key, error.vars)}</Alert> : null}
      <button type="submit" className="btn btn-accent w-full" disabled={busy}>
        {busy
          ? t('common.actions.loading')
          : t('account.payments.deposit.submit', {
              amount: checked.ok ? formatSantim(checked.amount) : '…',
            })}
      </button>
    </form>
  );
}

function RecentDeposits({ items }: { items: readonly Deposit[] }) {
  const t = useT();
  const locale = useLocale();
  return (
    <section className="space-y-2">
      <h2 className="px-3 font-bold">{t('account.payments.deposit.recent')}</h2>
      {items.length === 0 ? (
        <p className="card mx-3 text-center text-muted">{t('account.payments.deposit.noRecent')}</p>
      ) : (
        <ul className="border-t border-line">
          {items.map((d) => (
            <li key={d.id} className="list-row flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="font-semibold tabular-nums">ETB {formatSantim(d.amount)}</p>
                <p className="text-xxs text-muted">{formatDateTime(d.createdAt, locale)}</p>
              </div>
              <Chip tone={depositTone(d.status)}>{t(DEPOSIT_STATUS_LABEL[d.status])}</Chip>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Deposit page body: amount form → push / USSD / checkout instructions → polls
 * the deposit until it is final → refreshes the balance. `resumeId` is the
 * `?id=` a redirect checkout returns to.
 */
export function DepositPanel({ resumeId }: { resumeId: string | null }) {
  const t = useT();
  const { refreshWallet } = useSession();
  const { state, reload } = usePaymentOptions();
  const [recent, setRecent] = useState<Deposit[]>([]);
  const [resumeFailed, setResumeFailed] = useState(false);

  const loadRecent = useCallback(() => {
    paymentsApi
      .deposits()
      .then((r) => setRecent(r.items))
      .catch(() => undefined);
  }, []);

  const onFinal = useCallback(
    (_deposit: Deposit) => {
      void refreshWallet();
      loadRecent();
    },
    [refreshWallet, loadRecent],
  );
  const { deposit, setDeposit, stopped, recheck } = useDepositPolling(null, onFinal);

  useEffect(() => {
    loadRecent();
    void refreshWallet();
  }, [loadRecent, refreshWallet]);

  // Coming back from a hosted checkout: load that deposit and keep tracking it.
  useEffect(() => {
    if (resumeId === null) return;
    let cancelled = false;
    paymentsApi
      .deposit(resumeId)
      .then((d) => {
        if (cancelled) return;
        setDeposit(d);
        if (isDepositFinal(d.status)) onFinal(d);
      })
      .catch((e: unknown) => {
        if (!cancelled && isApiClientError(e)) setResumeFailed(true);
      });
    return () => {
      cancelled = true;
    };
    // setDeposit identity changes each render; run once per resume id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeId]);

  return (
    <div className="space-y-3">
      <div className="space-y-3 px-3">
        <PaymentDemoNotice state={state} />
        {state.status === 'loading' ? <Skeleton lines={4} /> : null}
        {state.status === 'error' ? (
          <div className="space-y-2">
            <Alert>{t('account.payments.unavailable')}</Alert>
            <button type="button" className="btn btn-outline w-full" onClick={reload}>
              {t('common.actions.retry')}
            </button>
          </div>
        ) : null}
        {resumeFailed ? <Alert>{t('common.errors.notFound')}</Alert> : null}
        {state.status === 'ready' && deposit !== null ? (
          <DepositProgress
            deposit={deposit}
            options={state.options}
            stopped={stopped}
            onRecheck={recheck}
            onAnother={() => setDeposit(null)}
            onDeposit={(d) => {
              setDeposit(d);
              if (isDepositFinal(d.status)) onFinal(d);
            }}
          />
        ) : null}
        {state.status === 'ready' && deposit === null ? (
          <DepositForm
            options={state.options}
            onCreated={(d) => {
              setDeposit(d);
              if (isDepositFinal(d.status)) onFinal(d);
            }}
          />
        ) : null}
      </div>
      <RecentDeposits items={recent} />
    </div>
  );
}
