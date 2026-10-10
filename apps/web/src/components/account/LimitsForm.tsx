'use client';

import type { RgLimitsResponse } from '@vamos/contracts';
import type { MessageKey, MessageVars } from '@vamos/i18n/translate';
import { useEffect, useState, type FormEvent } from 'react';
import { useLocale, useT } from '@/i18n/client';
import { accountApi } from '@/lib/api/account';
import { errorMessageKey, isApiClientError } from '@/lib/api/errors';
import { formatSantim } from '@/lib/format';
import { formatDate } from './dates';
import { detailString } from './errors';
import {
  LIMIT_FIELDS,
  LIMIT_GROUPS,
  buildLimitsRequest,
  limitEntry,
  limitFormFrom,
  type LimitField,
  type LimitFieldId,
  type LimitForm,
} from './limits';
import { Alert, Skeleton } from './ui';

const GROUP_LABEL: Record<(typeof LIMIT_GROUPS)[number], MessageKey> = {
  deposit: 'account.limits.groups.deposit',
  loss: 'account.limits.groups.loss',
  stake: 'account.limits.groups.stake',
};

const PERIOD_LABEL: Record<LimitField['period'], MessageKey> = {
  day: 'account.limits.periods.day',
  week: 'account.limits.periods.week',
  month: 'account.limits.periods.month',
  bet: 'account.limits.periods.bet',
};

interface Message {
  key: MessageKey;
  vars?: MessageVars;
  tone: 'error' | 'success' | 'info';
}

function LimitInput({
  field,
  limits,
  value,
  error,
  onChange,
}: {
  field: LimitField;
  limits: RgLimitsResponse;
  value: string;
  error: MessageKey | undefined;
  onChange: (value: string) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const id = `limit-${field.id.replace('.', '-')}`;
  const pending = limitEntry(limits, field).pending;
  const note = error
    ? t(error)
    : pending
      ? pending.amount === null
        ? t('account.limits.pendingRemoval', { date: formatDate(pending.effectiveFrom, locale) })
        : t('account.limits.pending', {
            amount: `ETB ${formatSantim(pending.amount)}`,
            date: formatDate(pending.effectiveFrom, locale),
          })
      : null;
  return (
    <div className="grid grid-cols-[6rem_1fr] items-center gap-x-2 gap-y-0.5">
      <label htmlFor={id} className="text-xs font-semibold">
        {t(PERIOD_LABEL[field.period])}
      </label>
      <div className="relative">
        <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-xs text-muted">
          ETB
        </span>
        <input
          id={id}
          name={field.id}
          className="input pl-11 tabular-nums"
          inputMode="decimal"
          autoComplete="off"
          placeholder={t('account.limits.noLimit')}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={note ? `${id}-note` : undefined}
        />
      </div>
      {note ? (
        <p
          id={`${id}-note`}
          className={`col-start-2 text-xxs ${error ? 'font-semibold text-down' : 'text-muted'}`}
        >
          {note}
        </p>
      ) : null}
    </div>
  );
}

export function LimitsForm() {
  const t = useT();
  const [limits, setLimits] = useState<RgLimitsResponse | null>(null);
  const [form, setForm] = useState<LimitForm | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const [errors, setErrors] = useState<Partial<Record<LimitFieldId, MessageKey>>>({});
  const [message, setMessage] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const abort = new AbortController();
    setLoadError(null);
    accountApi.limits(abort.signal).then(
      (result) => {
        if (abort.signal.aborted) return;
        setLimits(result);
        setForm(limitFormFrom(result));
      },
      (err: unknown) => {
        if (!abort.signal.aborted) setLoadError(err);
      },
    );
    return () => abort.abort();
  }, [attempt]);

  if (limits === null || form === null) {
    if (loadError === null) return <Skeleton lines={6} />;
    return (
      <div className="space-y-2 px-3">
        <Alert>{t(errorMessageKey(loadError))}</Alert>
        <button
          type="button"
          className="btn btn-outline w-full"
          onClick={() => setAttempt((n) => n + 1)}
        >
          {t('common.actions.retry')}
        </button>
      </div>
    );
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const diff = buildLimitsRequest(limits, form);
    setErrors(diff.errors);
    setMessage(null);
    if (Object.keys(diff.errors).length > 0) return;
    if (diff.request === null) {
      setMessage({ key: 'account.limits.unchanged', tone: 'info' });
      return;
    }
    setBusy(true);
    try {
      const updated = await accountApi.updateLimits(diff.request);
      setLimits(updated);
      setForm(limitFormFrom(updated));
      setMessage({ key: 'account.limits.saved', tone: 'success' });
    } catch (error) {
      if (isApiClientError(error) && error.code === 'invalid_limit') {
        const field = detailString(error, 'field') as LimitFieldId | null;
        if (field !== null) setErrors({ [field]: 'account.validation.amount' });
        setMessage({
          key: 'account.limits.invalid',
          vars: {
            min: formatSantim(detailString(error, 'min')),
            max: formatSantim(detailString(error, 'max')),
          },
          tone: 'error',
        });
      } else {
        setMessage({ key: errorMessageKey(error), tone: 'error' });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form noValidate onSubmit={submit} className="space-y-3 px-3">
      <p className="text-sm">{t('account.limits.intro')}</p>
      {LIMIT_GROUPS.map((group) => (
        <section
          key={group}
          role="group"
          aria-labelledby={`limits-${group}`}
          className="card space-y-2"
        >
          <h2 id={`limits-${group}`} className="font-bold">
            {t(GROUP_LABEL[group])}
          </h2>
          {LIMIT_FIELDS.filter((field) => field.group === group).map((field) => (
            <LimitInput
              key={field.id}
              field={field}
              limits={limits}
              value={form[field.id]}
              error={errors[field.id]}
              onChange={(value) => setForm({ ...form, [field.id]: value })}
            />
          ))}
        </section>
      ))}
      <p className="text-xs text-muted">{t('account.limits.emptyHint')}</p>
      {message ? <Alert tone={message.tone}>{t(message.key, message.vars)}</Alert> : null}
      <button type="submit" className="btn btn-primary w-full" disabled={busy}>
        {busy ? t('common.actions.loading') : t('account.limits.save')}
      </button>
    </form>
  );
}
