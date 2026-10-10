'use client';

import type { MessageKey } from '@vamos/i18n/translate';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { useT } from '@/i18n/client';
import { authApi } from '@/lib/api/account';
import { routes } from '@/lib/routes';
import { useSession } from '@/providers/SessionProvider';
import { formErrors } from './errors';
import { PasswordInput, PhoneInput } from './inputs';
import { registerHref } from './paths';
import { Alert, Field, describedBy } from './ui';
import { hasErrors, normalizePhone, validateLogin, type FieldErrors } from './validation';

type LoginField = 'phone' | 'password';

const ERRORS = {
  paths: {
    phone: ['phone', 'account.validation.phone'],
    password: ['password', 'account.validation.passwordRequired'],
  },
  codes: {
    invalid_credentials: { key: 'account.errors.invalidCredentials' },
    phone_not_verified: { key: 'account.errors.phoneNotVerified' },
    account_disabled: { key: 'account.errors.accountDisabled' },
    self_excluded: { key: 'account.errors.selfExcluded' },
  },
} as const;

export function LoginForm({ next, passwordChanged }: { next: string; passwordChanged: boolean }) {
  const t = useT();
  const router = useRouter();
  const session = useSession();
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [fields, setFields] = useState<FieldErrors<LoginField>>({});
  const [formError, setFormError] = useState<MessageKey | null>(null);
  const [busy, setBusy] = useState(false);

  // Signed in (now or already): continue to where the player was going.
  useEffect(() => {
    if (session.status === 'authenticated') router.replace(next);
  }, [session.status, next, router]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const local = validateLogin({ phone, password });
    setFields(local);
    setFormError(null);
    if (hasErrors(local)) return;
    setBusy(true);
    try {
      await authApi.login({ phone: normalizePhone(phone) ?? phone, password });
      await session.refresh();
    } catch (error) {
      const result = formErrors<LoginField>(error, ERRORS);
      setFields(result.fields);
      setFormError(result.form);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form noValidate onSubmit={submit} className="card mx-3 space-y-3">
      {passwordChanged ? <Alert tone="success">{t('account.login.passwordChanged')}</Alert> : null}
      {formError ? <Alert>{t(formError)}</Alert> : null}
      <Field
        id="login-phone"
        label={t('account.fields.phone')}
        error={fields.phone && t(fields.phone)}
      >
        <PhoneInput
          id="login-phone"
          name="phone"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          required
          {...describedBy('login-phone', fields.phone)}
        />
      </Field>
      <Field
        id="login-password"
        label={t('account.fields.password')}
        error={fields.password && t(fields.password)}
      >
        <PasswordInput
          id="login-password"
          name="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          {...describedBy('login-password', fields.password)}
        />
      </Field>
      <button type="submit" className="btn btn-primary w-full" disabled={busy}>
        {busy ? t('common.actions.loading') : t('account.login.submit')}
      </button>
      <p className="text-center">
        <Link href={routes.forgotPassword} className="text-xs font-semibold text-brand">
          {t('account.login.forgot')}
        </Link>
      </p>
      <p className="border-t border-line pt-3 text-center text-xs">
        {t('account.login.noAccount')}{' '}
        <Link href={registerHref(next)} className="font-bold text-brand">
          {t('account.login.register')}
        </Link>
      </p>
    </form>
  );
}
