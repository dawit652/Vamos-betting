'use client';

import type { PaymentOptionsResponse, PaymentProviderName, WithdrawalView } from '@vamos/contracts';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { formatDateTime } from '@/components/account/dates';
import type { Message } from '@/components/account/errors';
import { accountPaths } from '@/components/account/paths';
import { Alert, Chip, Field, Skeleton, describedBy } from '@/components/account/ui';
import { useLocale, useT } from '@/i18n/client';
import { newIdempotencyKey } from '@/lib/api/idempotency';
import { paymentsApi } from '@/lib/api/payments';
import { formatSantim } from '@/lib/format';
import { useSession } from '@/providers/SessionProvider';
import { CashAtShop } from './CashAtShop';
import { PaymentDemoNotice, PhoneReadOnly, ProviderField, usePaymentOptions } from './PaymentParts';
import { PayoutAccountPicker } from './PayoutAccounts';
import {
  AMOUNT_ERROR_KEY,
  WITHDRAWAL_POLL_MS,
  WITHDRAWAL_STATUS_LABEL,
  type RuleState,
  checkAmount,
  createIntentKeys,
  isDefiniteRefusal,
  isWithdrawalOpen,
  paymentErrorMessage,
  pickProvider,
  reviewReasonKey,
  stepLabelKey,
  upsertWithdrawal,
  withdrawRules,
  withdrawalTone,
} from './payments';

// Module level so the key outlives the form: a retry after a timeout reuses it.
const withdrawalKeys = createIntentKeys(newIdempotencyKey, 'withdraw');

const STEP_DOT: Record<string, string> = {
  done: 'bg-up text-white',
  current: 'bg-accent text-ink animate-pulse',
  upcoming: 'bg-line text-muted',
  failed: 'bg-down text-white',
};

/** requested → approved → processing → paid, ending in rejected / cancelled / failed when it stopped. */
function Tracker({ withdrawal }: { withdrawal: WithdrawalView }) {
  const t = useT();
  const locale = useLocale();
  return (
    <ol aria-label={t('account.payments.withdraw.steps')} className="space-y-1.5">
      {withdrawal.steps.map((step) => (
        <li
          key={step.key}
          className="flex items-center gap-2"
          aria-current={step.state === 'current' ? 'step' : undefined}
        >
          <span
            aria-hidden="true"
            className={`flex size-5 flex-none items-center justify-center rounded-full text-xxs font-bold ${STEP_DOT[step.state] ?? STEP_DOT.upcoming}`}
          >
            {step.state === 'done' ? '✓' : step.state === 'failed' ? '✕' : ''}
          </span>
          <span className={step.state === 'upcoming' ? 'text-muted' : 'font-semibold'}>
            {t(stepLabelKey(step, withdrawal.status))}
          </span>
          {step.at !== null ? (
            <span className="ml-auto text-xxs text-muted">{formatDateTime(step.at, locale)}</span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function WithdrawalCard({
  withdrawal,
  onCancel,
  cancelling,
  error,
}: {
  withdrawal: WithdrawalView;
  onCancel: (id: string) => void;
  cancelling: boolean;
  error: Message | null;
}) {
  const t = useT();
  const review = reviewReasonKey(withdrawal);
  const returned =
    withdrawal.status === 'rejected' ||
    withdrawal.status === 'cancelled' ||
    withdrawal.status === 'failed';
  return (
    <li className="card space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="font-bold tabular-nums">ETB {formatSantim(withdrawal.amount)}</p>
        <Chip tone={withdrawalTone(withdrawal.status)}>
          {t(WITHDRAWAL_STATUS_LABEL[withdrawal.status])}
        </Chip>
      </div>
      <p className="text-xxs text-muted">
        {withdrawal.destination !== null
          ? t('account.payments.withdraw.toAccount', {
              institution: withdrawal.destination.institutionName,
              account: withdrawal.destination.account,
            })
          : t('account.payments.withdraw.to', { phone: withdrawal.phone })}
      </p>
      <Tracker withdrawal={withdrawal} />
      {review ? <p className="text-muted">{t(review)}</p> : null}
      {withdrawal.status === 'rejected' && withdrawal.rejectionReason ? (
        <p className="text-muted">
          {t('account.payments.withdraw.rejectedWhy', { reason: withdrawal.rejectionReason })}
        </p>
      ) : null}
      {returned ? <p className="text-muted">{t('account.payments.withdraw.returned')}</p> : null}
      {withdrawal.manual && isWithdrawalOpen(withdrawal.status) ? (
        <p className="text-xxs text-muted">{t('account.payments.withdraw.manualNote')}</p>
      ) : null}
      {withdrawal.settlementReference !== null ? (
        <p className="text-xxs text-muted">
          {t('account.payments.withdraw.paidRef', { reference: withdrawal.settlementReference })}
        </p>
      ) : null}
      {error ? <Alert>{t(error.key, error.vars)}</Alert> : null}
      {withdrawal.cancellable ? (
        <button
          type="button"
          className="btn btn-outline w-full"
          disabled={cancelling}
          onClick={() => onCancel(withdrawal.id)}
        >
          {cancelling ? t('common.actions.loading') : t('account.payments.withdraw.cancel')}
        </button>
      ) : null}
    </li>
  );
}

function Rules({
  options,
  kycStatus,
  wageringRemaining,
  withdrawable,
}: {
  options: PaymentOptionsResponse;
  kycStatus: string | null;
  wageringRemaining: string | null;
  withdrawable: string | null;
}) {
  const t = useT();
  const { limits } = options;
  const manual = options.providers.some((p) => p.payouts && p.manual);
  const text = (id: ReturnType<typeof withdrawRules>[number]['id'], state: RuleState) => {
    const todo = state === 'todo';
    switch (id) {
      case 'kyc':
        return t(
          todo ? 'account.payments.withdraw.rules.kycTodo' : 'account.payments.withdraw.rules.kyc',
        );
      case 'wagering':
        if (state === 'info') return t('account.payments.withdraw.rules.wagering');
        return todo
          ? t('account.payments.withdraw.rules.wageringTodo', {
              remaining: formatSantim(wageringRemaining),
              withdrawable: formatSantim(withdrawable),
            })
          : t('account.payments.withdraw.rules.wageringOk');
      case 'ownPhone':
        return manual
          ? t('account.payments.withdraw.rules.ownAccounts')
          : t('account.payments.withdraw.rules.ownPhone');
      case 'dailyCap':
        return t('account.payments.withdraw.rules.dailyCap', {
          cap: formatSantim(limits.dailyWithdrawalCap),
        });
      case 'limits':
        return t('account.payments.withdraw.rules.limits', {
          min: formatSantim(limits.minWithdrawal),
          max: formatSantim(limits.maxWithdrawal),
        });
      case 'review':
        return t('account.payments.withdraw.rules.review', {
          auto: formatSantim(limits.autoApproveBelow),
        });
    }
  };
  return (
    <section className="card space-y-2">
      <h2 className="font-bold">{t('account.payments.withdraw.rulesTitle')}</h2>
      <ul className="space-y-1.5">
        {withdrawRules({ kycStatus, wageringRemaining }).map((rule) => (
          <li key={rule.id} className="flex gap-2">
            <span
              aria-hidden="true"
              className={`flex-none font-bold ${rule.state === 'ok' ? 'text-up' : rule.state === 'todo' ? 'text-down' : 'text-muted'}`}
            >
              {rule.state === 'ok' ? '✓' : rule.state === 'todo' ? '!' : '•'}
            </span>
            <span>
              {text(rule.id, rule.state)}
              {rule.id === 'kyc' && rule.state === 'todo' ? (
                <>
                  {' '}
                  <Link href={accountPaths.kyc} className="font-semibold text-brand underline">
                    {t('account.payments.withdraw.rules.kycLink')}
                  </Link>
                </>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

const WITHDRAW_FORM_ID = 'withdraw-form';

function WithdrawForm({
  options,
  onCreated,
}: {
  options: PaymentOptionsResponse;
  onCreated: (withdrawal: WithdrawalView) => void;
}) {
  const t = useT();
  const { me } = useSession();
  const providers = options.providers.filter((p) => p.payouts).map((p) => p.name);
  const [provider, setProvider] = useState<PaymentProviderName | null>(
    pickProvider(options, 'payouts'),
  );
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Message | null>(null);
  const [amountError, setAmountError] = useState<string | undefined>();
  const [payoutAccountId, setPayoutAccountId] = useState<string | null>(null);

  if (provider === null) {
    return <Alert tone="info">{t('account.payments.notAvailableForYou')}</Alert>;
  }
  const manual = options.providers.find((p) => p.name === provider)?.manual === true;

  const submit = async () => {
    if (busy) return;
    const { minWithdrawal, maxWithdrawal } = options.limits;
    const checked = checkAmount(input, minWithdrawal, maxWithdrawal);
    if (!checked.ok) {
      setAmountError(
        t(AMOUNT_ERROR_KEY[checked.reason], {
          min: formatSantim(minWithdrawal),
          max: formatSantim(maxWithdrawal),
        }),
      );
      return;
    }
    setAmountError(undefined);
    setError(null);
    if (manual && payoutAccountId === null) {
      setError({ key: 'account.payments.errors.payoutAccountRequired' });
      return;
    }
    setBusy(true);
    const key = withdrawalKeys.get(`${provider}:${checked.amount}:${payoutAccountId ?? ''}`);
    try {
      // No phone in the body: the API pays the registered phone (or a saved account in the
      // player's own name, SMS rail) only.
      const withdrawal = await paymentsApi.createWithdrawal(
        {
          amount: checked.amount,
          provider,
          ...(manual && payoutAccountId !== null ? { payoutAccountId } : {}),
        },
        key,
      );
      withdrawalKeys.clear();
      setInput('');
      onCreated(withdrawal);
    } catch (e) {
      if (isDefiniteRefusal(e)) withdrawalKeys.clear();
      setError(paymentErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const checked = checkAmount(input, options.limits.minWithdrawal, options.limits.maxWithdrawal);
  return (
    // The form holds only the amount (Enter submits it) and the button points at it: the payout
    // account picker has a form of its own (add a bank account), and forms must not nest.
    <div className="card space-y-3">
      <p className="text-muted">
        {manual ? t('account.payments.withdraw.introManual') : t('account.payments.withdraw.intro')}
      </p>
      <form
        id={WITHDRAW_FORM_ID}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field id="withdraw-amount" label={t('account.payments.amount')} error={amountError}>
          <input
            id="withdraw-amount"
            className="input tabular-nums"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            {...describedBy('withdraw-amount', amountError)}
          />
        </Field>
      </form>
      {manual ? (
        <PayoutAccountPicker value={payoutAccountId} onChange={setPayoutAccountId} />
      ) : (
        <Field
          id="withdraw-phone"
          label={t('account.payments.phone')}
          hint={t('account.payments.withdraw.phoneHint')}
        >
          <PhoneReadOnly id="withdraw-phone" phone={me?.phone ?? ''} />
        </Field>
      )}
      <Field id="withdraw-provider" label={t('account.payments.provider')}>
        <ProviderField
          id="withdraw-provider"
          providers={providers}
          value={provider}
          onChange={setProvider}
        />
      </Field>
      {error ? <Alert>{t(error.key, error.vars)}</Alert> : null}
      <button
        type="submit"
        form={WITHDRAW_FORM_ID}
        className="btn btn-accent w-full"
        disabled={busy}
      >
        {busy
          ? t('common.actions.loading')
          : t('account.payments.withdraw.submit', {
              amount: checked.ok ? formatSantim(checked.amount) : '…',
            })}
      </button>
    </div>
  );
}

/**
 * Withdraw page body: the rules, the request form and the status tracker of
 * every withdrawal (cancel while it is only requested). Open withdrawals are
 * refreshed every few seconds.
 */
export function WithdrawPanel() {
  const t = useT();
  const { me, refreshWallet } = useSession();
  const { state, reload } = usePaymentOptions();
  const [items, setItems] = useState<WithdrawalView[]>([]);
  const [wagering, setWagering] = useState<string | null>(null);
  const [withdrawable, setWithdrawable] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState<'requested' | 'cancelled' | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<{ id: string; message: Message } | null>(null);
  const previous = useRef<Map<string, string>>(new Map());

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const res = await paymentsApi.withdrawals(signal);
        setItems(res.items);
        setWagering(res.wageringRemaining);
        setWithdrawable(res.withdrawable);
        setLoaded(true);
        // A payout that finished (or came back) moved money: refresh the header balance.
        const moved = res.items.some((w) => {
          const before = previous.current.get(w.id);
          return before !== undefined && before !== w.status;
        });
        previous.current = new Map(res.items.map((w) => [w.id, w.status]));
        if (moved) void refreshWallet();
      } catch {
        if (signal?.aborted !== true) setLoaded(true);
      }
    },
    [refreshWallet],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    void refreshWallet();
    return () => controller.abort();
  }, [load, refreshWallet]);

  const anyOpen = items.some((w) => isWithdrawalOpen(w.status));
  useEffect(() => {
    if (!anyOpen) return;
    const controller = new AbortController();
    const timer = setInterval(() => void load(controller.signal), WITHDRAWAL_POLL_MS);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [anyOpen, load]);

  const cancel = async (id: string) => {
    if (cancelling !== null) return;
    setCancelling(id);
    setCancelError(null);
    try {
      const updated = await paymentsApi.cancelWithdrawal(id);
      setItems((current) => upsertWithdrawal(current, updated));
      previous.current.set(updated.id, updated.status);
      setNotice('cancelled');
      void refreshWallet();
      void load();
    } catch (e) {
      setCancelError({ id, message: paymentErrorMessage(e) });
      void load();
    } finally {
      setCancelling(null);
    }
  };

  return (
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
      {state.status === 'ready' ? (
        <>
          <Rules
            options={state.options}
            kycStatus={me?.kyc.status ?? null}
            wageringRemaining={loaded ? wagering : null}
            withdrawable={loaded ? withdrawable : null}
          />
          {notice === 'requested' ? (
            <Alert tone="success">{t('account.payments.withdraw.requested')}</Alert>
          ) : null}
          {notice === 'cancelled' ? (
            <Alert tone="success">{t('account.payments.withdraw.cancelled')}</Alert>
          ) : null}
          <WithdrawForm
            options={state.options}
            onCreated={(w) => {
              setItems((current) => upsertWithdrawal(current, w));
              previous.current.set(w.id, w.status);
              setNotice('requested');
              void refreshWallet();
              void load();
            }}
          />
        </>
      ) : null}
      <CashAtShop />
      <section className="space-y-2" aria-live="polite">
        <h2 className="font-bold">{t('account.payments.withdraw.listTitle')}</h2>
        {!loaded ? <Skeleton lines={3} /> : null}
        {loaded && items.length === 0 ? (
          <p className="card text-center text-muted">{t('account.payments.withdraw.none')}</p>
        ) : null}
        <ul className="space-y-2">
          {items.map((w) => (
            <WithdrawalCard
              key={w.id}
              withdrawal={w}
              onCancel={(id) => void cancel(id)}
              cancelling={cancelling === w.id}
              error={cancelError?.id === w.id ? cancelError.message : null}
            />
          ))}
        </ul>
      </section>
    </div>
  );
}
