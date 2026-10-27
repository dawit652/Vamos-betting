'use client';

import type { PlayerSessionView } from '@vamos/contracts';
import type { MessageKey, MessageVars } from '@vamos/i18n/translate';
import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useLocale, useT } from '@/i18n/client';
import { securityApi } from '@/lib/api/account';
import { errorMessageKey } from '@/lib/api/errors';
import { routes } from '@/lib/routes';
import { formatDateTime } from './dates';
import { formErrors } from './errors';
import { PasswordInput, PasswordStrengthMeter } from './inputs';
import { deviceLabel, exportFileName } from './security';
import { Alert, Field, Skeleton, describedBy } from './ui';
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  hasErrors,
  passwordError,
  type FieldErrors,
} from './validation';

type PasswordField = 'currentPassword' | 'newPassword' | 'confirmPassword';

const PASSWORD_ERRORS = {
  paths: {
    currentPassword: ['currentPassword', 'account.validation.passwordRequired'],
    newPassword: ['newPassword', 'account.validation.passwordShort'],
  },
  codes: {
    reauth_failed: { field: 'currentPassword', key: 'account.security.wrongPassword' },
    weak_password: { field: 'newPassword', key: 'account.validation.weakPassword' },
    password_unchanged: { field: 'newPassword', key: 'account.security.unchanged' },
  },
} as const;

interface Notice {
  key: MessageKey;
  vars?: MessageVars;
  tone: 'error' | 'success';
}

/** Change the password with the current one (POST /me/password). */
function ChangePasswordForm({ onChanged }: { onChanged: () => void }) {
  const t = useT();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [fields, setFields] = useState<FieldErrors<PasswordField>>({});
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const local: FieldErrors<PasswordField> = {};
    if (currentPassword === '') local.currentPassword = 'account.validation.passwordRequired';
    const weak = passwordError(newPassword);
    if (weak) local.newPassword = weak;
    else if (confirmPassword !== newPassword) {
      local.confirmPassword = 'account.validation.passwordMismatch';
    }
    setFields(local);
    setNotice(null);
    if (hasErrors(local)) return;
    setBusy(true);
    try {
      await securityApi.changePassword({ currentPassword, newPassword });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setNotice({ key: 'account.security.changed', tone: 'success' });
      onChanged();
    } catch (error) {
      const result = formErrors<PasswordField>(error, PASSWORD_ERRORS);
      setFields(result.fields);
      if (result.form) setNotice({ key: result.form, tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const error = (field: PasswordField) => (fields[field] ? t(fields[field]) : undefined);

  return (
    <form noValidate onSubmit={submit} className="card mx-3 space-y-3">
      <h2 className="text-sm font-bold">{t('account.security.passwordTitle')}</h2>
      <p className="text-muted">{t('account.security.passwordIntro')}</p>
      {notice ? <Alert tone={notice.tone}>{t(notice.key, notice.vars)}</Alert> : null}
      <Field
        id="security-current"
        label={t('account.security.currentPassword')}
        error={error('currentPassword')}
      >
        <PasswordInput
          id="security-current"
          name="currentPassword"
          autoComplete="current-password"
          maxLength={MAX_PASSWORD_LENGTH}
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          required
          {...describedBy('security-current', error('currentPassword'))}
        />
      </Field>
      <Field
        id="security-new"
        label={t('account.fields.newPassword')}
        hint={t('account.fields.passwordHint')}
        error={error('newPassword')}
      >
        <PasswordInput
          id="security-new"
          name="newPassword"
          autoComplete="new-password"
          minLength={MIN_PASSWORD_LENGTH}
          maxLength={MAX_PASSWORD_LENGTH}
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          required
          {...describedBy('security-new', error('newPassword'), true)}
        />
        <PasswordStrengthMeter password={newPassword} />
      </Field>
      <Field
        id="security-confirm"
        label={t('account.fields.confirmPassword')}
        error={error('confirmPassword')}
      >
        <PasswordInput
          id="security-confirm"
          name="confirmPassword"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          required
          {...describedBy('security-confirm', error('confirmPassword'))}
        />
      </Field>
      <button type="submit" className="btn btn-primary w-full" disabled={busy}>
        {busy ? t('common.actions.loading') : t('account.security.submit')}
      </button>
    </form>
  );
}

function SessionRow({
  session,
  busy,
  onEnd,
}: {
  session: PlayerSessionView;
  busy: boolean;
  onEnd: (id: string) => void;
}) {
  const t = useT();
  const locale = useLocale();
  return (
    <li className="flex items-start justify-between gap-3 border-t border-line pt-2">
      <div className="min-w-0 space-y-0.5">
        <p className="font-semibold">
          {deviceLabel(session.userAgent) ?? t('account.security.unknownDevice')}
          {session.current ? (
            <span className="ml-2 text-xs text-up">{t('account.security.thisDevice')}</span>
          ) : null}
        </p>
        <p className="text-xs text-muted">
          {t('account.security.lastActive', { time: formatDateTime(session.lastSeenAt, locale) })}
          {session.ip ? ` · ${session.ip}` : ''}
        </p>
        <p className="text-xs text-muted">
          {t('account.security.signedIn', { time: formatDateTime(session.createdAt, locale) })}
        </p>
      </div>
      {session.current ? null : (
        <button
          type="button"
          className="btn btn-outline flex-none text-xs"
          disabled={busy}
          onClick={() => onEnd(session.id)}
        >
          {t('account.security.endOne')}
        </button>
      )}
    </li>
  );
}

/** The live sessions (GET /me/sessions); others end after the password (POST /me/sessions/revoke). */
function SessionsList({ reload }: { reload: number }) {
  const t = useT();
  const [items, setItems] = useState<PlayerSessionView[] | null>(null);
  const [password, setPassword] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [passwordError, setPasswordError] = useState<MessageKey | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await securityApi.sessions(signal);
      setItems(response.items);
    } catch (error) {
      if (signal?.aborted) return;
      setNotice({ key: errorMessageKey(error), tone: 'error' });
      setItems([]);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, reload]);

  const end = async (sessionId?: string) => {
    if (busy) return;
    setNotice(null);
    if (password === '') {
      setPasswordError('account.validation.passwordRequired');
      return;
    }
    setPasswordError(null);
    setBusy(true);
    try {
      const { revoked } = await securityApi.revokeSessions(
        sessionId === undefined ? { password } : { password, sessionId },
      );
      setPassword('');
      setNotice({ key: 'account.security.ended', vars: { count: revoked }, tone: 'success' });
      await load();
    } catch (error) {
      const result = formErrors<'password'>(error, {
        codes: { reauth_failed: { field: 'password', key: 'account.security.wrongPassword' } },
      });
      if (result.fields.password) setPasswordError(result.fields.password);
      if (result.form) setNotice({ key: result.form, tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  if (items === null) return <Skeleton />;
  const others = items.filter((item) => !item.current);
  const passwordMessage = passwordError ? t(passwordError) : undefined;

  return (
    <section className="card mx-3 space-y-3">
      <h2 className="text-sm font-bold">{t('account.security.sessionsTitle')}</h2>
      <p className="text-muted">{t('account.security.sessionsIntro')}</p>
      {notice ? <Alert tone={notice.tone}>{t(notice.key, notice.vars)}</Alert> : null}
      <ul className="space-y-2">
        {items.map((session) => (
          <SessionRow key={session.id} session={session} busy={busy} onEnd={(id) => void end(id)} />
        ))}
      </ul>
      {others.length === 0 ? (
        <p className="text-xs text-muted">{t('account.security.none')}</p>
      ) : (
        <>
          <Field
            id="security-sessions-password"
            label={t('account.security.password')}
            hint={t('account.security.passwordHint')}
            error={passwordMessage}
          >
            <PasswordInput
              id="security-sessions-password"
              name="password"
              autoComplete="current-password"
              maxLength={MAX_PASSWORD_LENGTH}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              {...describedBy('security-sessions-password', passwordMessage, true)}
            />
          </Field>
          <button
            type="button"
            className="btn btn-primary w-full"
            disabled={busy}
            onClick={() => void end()}
          >
            {busy ? t('common.actions.loading') : t('account.security.endOthers')}
          </button>
        </>
      )}
    </section>
  );
}

/** A copy of the player's data (GET /me/data-export, ASVS 8.3.2), saved as a JSON file. */
function DataExportCard() {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);

  const download = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const data = await securityApi.exportData();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = exportFileName(new Date());
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (failure) {
      setError(errorMessageKey(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card mx-3 space-y-3">
      <h2 className="text-sm font-bold">{t('account.security.dataTitle')}</h2>
      <p className="text-muted">{t('account.security.dataIntro')}</p>
      {error ? <Alert>{t(error)}</Alert> : null}
      <button
        type="button"
        className="btn btn-outline w-full"
        disabled={busy}
        onClick={() => void download()}
      >
        {busy ? t('common.actions.loading') : t('account.security.dataDownload')}
      </button>
      <Link href={routes.privacy} className="block text-center text-xs font-semibold text-brand">
        {t('account.security.privacyLink')}
      </Link>
    </section>
  );
}

/** The "Password and devices" page (ASVS 2.1.5, 2.1.6, 3.3.3, 3.3.4, 8.3.2). */
export function SecurityView() {
  const [reload, setReload] = useState(0);
  return (
    <div className="space-y-3 pb-3">
      <ChangePasswordForm onChanged={() => setReload((n) => n + 1)} />
      <SessionsList reload={reload} />
      <DataExportCard />
    </div>
  );
}
