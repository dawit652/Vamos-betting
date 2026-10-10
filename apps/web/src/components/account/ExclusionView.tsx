'use client';

import type { MessageKey } from '@vamos/i18n/translate';
import Link from 'next/link';
import { useState } from 'react';
import { useLocale, useT } from '@/i18n/client';
import { accountApi } from '@/lib/api/account';
import { errorMessageKey, isApiClientError } from '@/lib/api/errors';
import { routes } from '@/lib/routes';
import { useSession } from '@/providers/SessionProvider';
import { SignInPrompt } from './AuthGate';
import { formatDate, formatDateTime } from './dates';
import {
  COOL_OFF_DURATIONS,
  DURATION_LABEL,
  SELF_EXCLUSION_DURATIONS,
  exclusionRequest,
  previewEnd,
  type ExclusionDuration,
} from './exclusion';
import { Alert, Skeleton } from './ui';

type Done = { kind: 'cool_off'; endsAt: string | null } | { kind: 'self_exclusion' };

function DurationGroup({
  title,
  body,
  durations,
  selected,
  onSelect,
}: {
  title: MessageKey;
  body: MessageKey;
  durations: readonly ExclusionDuration[];
  selected: ExclusionDuration | null;
  onSelect: (duration: ExclusionDuration) => void;
}) {
  const t = useT();
  return (
    <fieldset className="card space-y-2">
      <legend className="float-left w-full font-bold">{t(title)}</legend>
      <p className="clear-left text-xs text-muted">{t(body)}</p>
      <div className="flex flex-wrap gap-2">
        {durations.map((duration) => (
          <label
            key={duration}
            className={`chip cursor-pointer ${
              selected === duration ? 'border-brand bg-brand text-brand-ink' : ''
            }`}
          >
            <input
              type="radio"
              name="duration"
              value={duration}
              className="sr-only"
              checked={selected === duration}
              onChange={() => onSelect(duration)}
            />
            {t(DURATION_LABEL[duration])}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function ExclusionView() {
  const t = useT();
  const locale = useLocale();
  const session = useSession();
  const [selected, setSelected] = useState<ExclusionDuration | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const [done, setDone] = useState<Done | null>(null);

  // Shown even after the self-exclusion signed the player out.
  if (done !== null) {
    return (
      <div className="space-y-3 px-3">
        <Alert tone="success">
          {done.kind === 'self_exclusion'
            ? t('account.exclusion.doneSelf')
            : t('account.exclusion.doneCoolOff', {
                date: done.endsAt ? formatDateTime(done.endsAt, locale) : '–',
              })}
        </Alert>
        <Link href={routes.responsibleGambling} className="btn btn-outline w-full">
          {t('account.exclusion.support')}
        </Link>
      </div>
    );
  }
  if (session.status === 'loading') return <Skeleton />;
  if (session.status === 'anonymous' || session.me === null) return <SignInPrompt />;

  const active = session.me.exclusion;
  const choose = (duration: ExclusionDuration) => {
    setSelected(duration);
    setConfirming(false);
    setUnderstood(false);
    setError(null);
  };

  const confirm = async () => {
    if (selected === null || !understood || busy) return;
    setBusy(true);
    setError(null);
    const request = exclusionRequest(selected);
    try {
      const { exclusion } = await accountApi.createExclusion(request);
      if (request.kind === 'self_exclusion') {
        setDone({ kind: 'self_exclusion' });
        // The API revoked every session and cleared the cookies.
        await session.refresh();
      } else {
        setDone({ kind: 'cool_off', endsAt: exclusion.endsAt });
        await session.refresh();
      }
    } catch (err) {
      setError(
        isApiClientError(err) && err.code === 'exclusion_active'
          ? 'account.exclusion.alreadyActive'
          : errorMessageKey(err),
      );
      setBusy(false);
    }
  };

  const end = selected === null ? null : previewEnd(selected, new Date());
  const isSelf = selected !== null && exclusionRequest(selected).kind === 'self_exclusion';
  const confirmText: MessageKey = !isSelf
    ? 'account.exclusion.confirmCoolOff'
    : end === null
      ? 'account.exclusion.confirmSelfPermanent'
      : 'account.exclusion.confirmSelf';

  return (
    <div className="space-y-3 px-3">
      <p className="text-sm">{t('account.exclusion.intro')}</p>
      {active ? (
        <Alert tone="demo">
          {active.endsAt
            ? t('account.exclusion.active', { date: formatDateTime(active.endsAt, locale) })
            : t('account.exclusion.activePermanent')}
        </Alert>
      ) : null}
      <DurationGroup
        title="account.exclusion.coolOff.title"
        body="account.exclusion.coolOff.body"
        durations={COOL_OFF_DURATIONS}
        selected={selected}
        onSelect={choose}
      />
      <DurationGroup
        title="account.exclusion.self.title"
        body="account.exclusion.self.body"
        durations={SELF_EXCLUSION_DURATIONS}
        selected={selected}
        onSelect={choose}
      />
      {selected !== null && !confirming ? (
        <button
          type="button"
          className="btn btn-primary w-full"
          onClick={() => setConfirming(true)}
        >
          {t('account.exclusion.choose')}
        </button>
      ) : null}
      {selected !== null && confirming ? (
        <section
          role="alertdialog"
          aria-labelledby="exclusion-confirm-title"
          className="card space-y-3 border-2 border-down"
        >
          <h2 id="exclusion-confirm-title" className="font-bold">
            {t('account.exclusion.confirmTitle')}: {t(DURATION_LABEL[selected])}
          </h2>
          <p>{t(confirmText, { date: end ? formatDate(end, locale) : '' })}</p>
          <p className="font-semibold text-down">{t('account.exclusion.irreversible')}</p>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-0.5 size-5 flex-none accent-brand"
              checked={understood}
              onChange={(e) => setUnderstood(e.target.checked)}
            />
            <span>{t('account.exclusion.understand')}</span>
          </label>
          {error ? <Alert>{t(error)}</Alert> : null}
          <div className="flex gap-2">
            <button
              type="button"
              className="btn flex-1 bg-down text-white"
              disabled={!understood || busy}
              onClick={() => void confirm()}
            >
              {busy ? t('common.actions.loading') : t('account.exclusion.confirm')}
            </button>
            <button
              type="button"
              className="btn btn-outline flex-1"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              {t('common.actions.cancel')}
            </button>
          </div>
        </section>
      ) : null}
      <p className="text-xs">
        <Link href={routes.responsibleGambling} prefetch={false} className="text-brand underline">
          {t('account.exclusion.support')}
        </Link>
      </p>
    </div>
  );
}
