'use client';

import type { MessageKey } from '@vamos/i18n/translate';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { useT } from '@/i18n/client';
import { authApi } from '@/lib/api/account';
import { formErrors, retryAfterSeconds } from './errors';
import { PhoneInput } from './inputs';
import { accountPaths } from './paths';
import { setPendingResetPhone } from './pending';
import { Alert, Field, describedBy } from './ui';
import { normalizePhone, phoneError } from './validation';

const ERRORS = {
  paths: { phone: ['phone', 'account.validation.phone'] },
  codes: { invalid_phone: { field: 'phone', key: 'account.validation.phone' } },
} as const;

export function ForgotForm() {
  const t = useT();
  const router = useRouter();
  const [phone, setPhone] = useState('');
  const [phoneErr, setPhoneErr] = useState<MessageKey | undefined>(undefined);
  const [formError, setFormError] = useState<MessageKey | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const local = phoneError(phone);
    setPhoneErr(local);
    setFormError(null);
    if (local) return;
    const normalized = normalizePhone(phone) ?? phone;
    setBusy(true);
    try {
      await authApi.forgotPassword({ phone: normalized });
      setPendingResetPhone(normalized);
      router.push(accountPaths.resetPassword);
    } catch (error) {
      // A code was sent moments ago: go on and enter it.
      if (retryAfterSeconds(error) !== null) {
        setPendingResetPhone(normalized);
        router.push(accountPaths.resetPassword);
        return;
      }
      const result = formErrors<'phone'>(error, ERRORS);
      setPhoneErr(result.fields.phone);
      setFormError(result.form);
      setBusy(false);
    }
  };

  const errorText = phoneErr ? t(phoneErr) : undefined;
  return (
    <form noValidate onSubmit={submit} className="card mx-3 space-y-3">
      <p className="text-muted">{t('account.forgot.intro')}</p>
      {formError ? <Alert>{t(formError)}</Alert> : null}
      <Field id="forgot-phone" label={t('account.fields.phone')} error={errorText}>
        <PhoneInput
          id="forgot-phone"
          name="phone"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          required
          {...describedBy('forgot-phone', errorText)}
        />
      </Field>
      <button type="submit" className="btn btn-primary w-full" disabled={busy}>
        {busy ? t('common.actions.loading') : t('account.forgot.submit')}
      </button>
    </form>
  );
}
