'use client';

import type { MeResponse } from '@vamos/contracts';
import type { MessageKey } from '@vamos/i18n/translate';
import { formatMsisdnLocal } from '@vamos/core';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { LocaleSwitcher } from '@/components/shell/LocaleSwitcher';
import { useLocale, useT } from '@/i18n/client';
import { accountApi } from '@/lib/api/account';
import { routes } from '@/lib/routes';
import { useSession } from '@/providers/SessionProvider';
import { formatBirthDate, formatDate } from './dates';
import { formErrors } from './errors';
import { accountPaths } from './paths';
import { KYC_LABEL, KYC_TONE } from './kyc';
import { Alert, Chip, MenuLink, Row } from './ui';
import { fullNameError } from './validation';

function localPhone(phone: string): string {
  try {
    return formatMsisdnLocal(phone);
  } catch {
    return phone;
  }
}

const NAME_ERRORS = {
  paths: { fullName: ['fullName', 'account.validation.fullName'] },
  codes: { name_locked: { field: 'fullName', key: 'account.overview.nameLocked' } },
} as const;

function NameEditor({ me, onSaved }: { me: MeResponse; onSaved: () => Promise<void> }) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(me.fullName ?? '');
  const [error, setError] = useState<MessageKey | undefined>(undefined);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const locked = me.kyc.status === 'verified';

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const local = fullNameError(name);
    setError(local);
    if (local || busy) return;
    setBusy(true);
    try {
      await accountApi.updateMe({ fullName: name.trim() });
      await onSaved();
      setEditing(false);
      setSaved(true);
    } catch (err) {
      const result = formErrors<'fullName'>(err, NAME_ERRORS);
      setError(result.fields.fullName ?? result.form ?? undefined);
    } finally {
      setBusy(false);
    }
  };

  if (!editing) {
    return (
      <>
        <Row label={t('account.overview.fullName')}>
          {me.fullName ?? <span className="text-muted">{t('account.overview.noName')}</span>}
          {locked ? null : (
            <button
              type="button"
              className="ml-2 text-xs font-semibold text-brand underline"
              onClick={() => {
                setEditing(true);
                setSaved(false);
              }}
            >
              {t('account.overview.editName')}
            </button>
          )}
        </Row>
        {saved ? (
          <div className="py-1">
            <Alert tone="success">{t('account.overview.nameSaved')}</Alert>
          </div>
        ) : null}
      </>
    );
  }

  return (
    <div className="py-1">
      <form noValidate onSubmit={submit} className="space-y-2">
        <label htmlFor="profile-name" className="block text-xs font-semibold">
          {t('account.fields.fullName')}
        </label>
        <input
          id="profile-name"
          className="input"
          autoComplete="name"
          maxLength={120}
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-invalid={error ? true : undefined}
        />
        {error ? <p className="text-xs font-semibold text-down">{t(error)}</p> : null}
        <div className="flex gap-2">
          <button type="submit" className="btn btn-primary flex-1" disabled={busy}>
            {t('common.actions.save')}
          </button>
          <button
            type="button"
            className="btn btn-outline flex-1"
            onClick={() => {
              setEditing(false);
              setName(me.fullName ?? '');
              setError(undefined);
            }}
          >
            {t('common.actions.cancel')}
          </button>
        </div>
      </form>
    </div>
  );
}

export function AccountOverview() {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const session = useSession();
  const [leaving, setLeaving] = useState(false);
  const [logoutFailed, setLogoutFailed] = useState(false);
  const me = session.me;
  if (me === null) return null;

  const logout = async () => {
    setLeaving(true);
    setLogoutFailed(false);
    if (await session.logout()) {
      router.replace(routes.home);
      return;
    }
    setLeaving(false);
    setLogoutFailed(true);
  };

  const exclusion = me.exclusion;
  return (
    <div className="space-y-3 px-3">
      {exclusion?.kind === 'cool_off' && exclusion.endsAt ? (
        <Alert tone="demo">
          {t('account.overview.coolOffActive', { date: formatDate(exclusion.endsAt, locale) })}
        </Alert>
      ) : !me.canGamble ? (
        <Alert tone="demo">{t('account.overview.cannotGamble')}</Alert>
      ) : null}
      <section className="card">
        <dl className="text-sm">
          <Row label={t('account.overview.phone')}>{localPhone(me.phone)}</Row>
          <NameEditor me={me} onSaved={session.refresh} />
          <Row label={t('account.overview.dateOfBirth')}>
            {formatBirthDate(me.dateOfBirth, locale)}
          </Row>
          <Row label={t('account.overview.memberSince')}>{formatDate(me.createdAt, locale)}</Row>
          <Row label={t('account.overview.identity')}>
            <Chip tone={KYC_TONE[me.kyc.status]}>{t(KYC_LABEL[me.kyc.status])}</Chip>
          </Row>
        </dl>
      </section>

      <section className="card space-y-2">
        <h2 className="text-xs font-semibold text-muted">{t('account.overview.language')}</h2>
        <LocaleSwitcher />
      </section>

      <nav aria-label={t('account.overview.settings')} className="card p-0">
        <ul>
          <MenuLink href={routes.wallet}>{t('account.overview.menu.wallet')}</MenuLink>
          <MenuLink href={routes.myBets}>{t('account.overview.menu.myBets')}</MenuLink>
          <MenuLink href={accountPaths.kyc}>{t('account.overview.menu.kyc')}</MenuLink>
          <MenuLink href={accountPaths.limits}>{t('account.overview.menu.limits')}</MenuLink>
          <MenuLink href={accountPaths.selfExclusion}>
            {t('account.overview.menu.exclusion')}
          </MenuLink>
          <MenuLink href={routes.responsibleGambling}>
            {t('account.overview.menu.responsibleGambling')}
          </MenuLink>
          <MenuLink href={routes.help}>{t('account.overview.menu.help')}</MenuLink>
        </ul>
      </nav>

      {logoutFailed ? <Alert>{t('account.overview.logoutFailed')}</Alert> : null}
      <button
        type="button"
        className="btn btn-outline w-full text-down"
        disabled={leaving}
        onClick={() => void logout()}
      >
        {leaving ? t('common.actions.loading') : t('account.overview.logout')}
      </button>
    </div>
  );
}
