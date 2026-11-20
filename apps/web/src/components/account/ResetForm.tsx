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
import { DemoOtpHint, OtpInput, PhoneInput, PinInput } from './inputs';
import { getPendingResetPhone, setPendingResetPhone } from './pending';
import { Alert, Field, describedBy } from './ui';
import {
  cleanOtp,
  hasErrors,
  normalizePhone,
  validateReset,
  type FieldErrors,
  type ResetInput,
} from './validation';

type ResetField = keyof ResetInput;

const ERRORS = {
  paths: {
    phone: ['phone', 'account.validation.phone'],
    code: ['code', 'account.validation.otp'],
    newPassword: ['newPassword', 'account.validation.pinFormat'],
  },
  codes: {
    invalid_phone: { field: 'phone', key: 'account.validation.phone' },
    otp_expired: { field: 'code', key: 'account.validation.otpExpired' },
    otp_invalid: { field: 'code', key: 'account.validation.otpInvalid' },
    weak_password: { field: 'newPassword', key: 'account.validation.weakPassword' },
  },
} as const;

export function ResetForm() {
  const t = useT();
  const router = useRouter();
  const session = useSession();
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [fields, setFields] = useState<FieldErrors<ResetField>>({});
  const [formError, setFormError] = useState<MessageKey | null>(null);
  const [busy, setBusy] = useState(false);

  // The number typed on the previous page (kept in memory, not in the URL).
  useEffect(() => {
    const pending = getPendingResetPhone();
    if (pending !== null) setPhone((current) => (current === '' ? pending : current));
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const local = validateReset({ phone, code, newPassword, confirmPassword });
    setFields(local);
    setFormError(null);
    if (hasErrors(local)) return;
    setBusy(true);
    try {
      await authApi.resetPassword({ phone: normalizePhone(phone) ?? phone, code, newPassword });
      setPendingResetPhone(null);
      // Every session of the account was revoked, this device included.
      await session.refresh();
      router.replace(`${routes.login}?reset=1`);
    } catch (error) {
      const result = formErrors<ResetField>(error, ERRORS);
      setFields(result.fields);
      setFormError(result.form);
      setBusy(false);
    }
  };

  const error = (field: ResetField) => (fields[field] ? t(fields[field]) : undefined);

  return (
    <form method="post" noValidate onSubmit={submit} className="card mx-3 space-y-3">
      <p className="text-muted">{t('account.reset.intro')}</p>
      <DemoOtpHint phone={normalizePhone(phone)} />
      {formError ? <Alert>{t(formError)}</Alert> : null}
      <Field id="reset-phone" label={t('account.fields.phone')} error={error('phone')}>
        <PhoneInput
          id="reset-phone"
          name="phone"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          required
          {...describedBy('reset-phone', error('phone'))}
        />
      </Field>
      <Field id="reset-code" label={t('account.fields.code')} error={error('code')}>
        <OtpInput
          id="reset-code"
          name="code"
          value={code}
          onChange={(e) => setCode(cleanOtp(e.target.value))}
          required
          {...describedBy('reset-code', error('code'))}
        />
      </Field>
      <Field
        id="reset-password"
        label={t('account.fields.newPin')}
        hint={t('account.fields.pinHint')}
        error={error('newPassword')}
      >
        <PinInput
          id="reset-password"
          name="newPassword"
          autoComplete="new-password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          required
          {...describedBy('reset-password', error('newPassword'), true)}
        />
      </Field>
      <Field
        id="reset-confirm"
        label={t('account.fields.confirmPin')}
        error={error('confirmPassword')}
      >
        <PinInput
          id="reset-confirm"
          name="confirmPassword"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          required
          {...describedBy('reset-confirm', error('confirmPassword'))}
        />
      </Field>
      <button type="submit" className="btn btn-primary w-full" disabled={busy}>
        {busy ? t('common.actions.loading') : t('account.reset.submit')}
      </button>
      <p className="text-center">
        <Link href={routes.forgotPassword} className="text-xs font-semibold text-brand">
          {t('account.reset.requestAgain')}
        </Link>
      </p>
    </form>
  );
}
