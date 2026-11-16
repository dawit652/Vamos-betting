'use client';

import type { MessageKey } from '@vamos/i18n/translate';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { useLocale, useT } from '@/i18n/client';
import { authApi } from '@/lib/api/account';
import { IS_DEMO } from '@/lib/mode';
import { routes } from '@/lib/routes';
import { useSession } from '@/providers/SessionProvider';
import { formErrors, retryAfterSeconds } from './errors';
import { PhoneInput, PinInput } from './inputs';
import { accountPaths, afterSignUp, loginHref } from './paths';
import { setPendingRegistration } from './pending';
import { Alert, Field, describedBy } from './ui';
import {
  hasErrors,
  normalizePhone,
  validateRegister,
  type FieldErrors,
  type RegisterField,
} from './validation';

const ERRORS = {
  paths: {
    phone: ['phone', 'account.validation.phone'],
    password: ['password', 'account.validation.pinFormat'],
  },
  codes: {
    invalid_phone: { field: 'phone', key: 'account.validation.phone' },
    phone_taken: { field: 'phone', key: 'account.errors.phoneTaken' },
    weak_password: { field: 'password', key: 'account.validation.weakPassword' },
  },
} as const;

export function RegisterForm({ next }: { next: string }) {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const session = useSession();
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [fields, setFields] = useState<FieldErrors<RegisterField>>({});
  const [formError, setFormError] = useState<MessageKey | null>(null);
  const [busy, setBusy] = useState(false);
  // Seconds until the API sends another code (after a 429 otp_cooldown / otp_limit).
  const [cooldown, setCooldown] = useState(0);
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  useEffect(() => {
    if (session.status === 'authenticated') router.replace(next);
  }, [session.status, next, router]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || cooldown > 0) return;
    const local = validateRegister({ phone, password });
    setFields(local);
    setFormError(null);
    if (hasErrors(local)) return;
    const normalized = normalizePhone(phone) ?? phone;
    setBusy(true);
    try {
      const response = await authApi.register({
        phone: normalized,
        password,
        locale,
        acceptTerms: true,
      });
      if (response.registrationWithoutSms && response.demoOtp) {
        // No SMS gateway: the API handed the code back, so confirm it here (the phone is not proven).
        await authApi.verifyOtp({
          phone: normalized,
          code: response.demoOtp,
          purpose: 'register',
          registrationToken: response.registrationToken,
        });
        await session.refresh();
        router.replace(afterSignUp(next));
        return;
      }
      setPendingRegistration({
        phone: normalized,
        registrationToken: response.registrationToken,
        otpSentTo: response.otpSentTo,
        otpExpiresAt: response.otpExpiresAt,
        demoOtp: response.demoOtp ?? null,
        next,
      });
      router.push(accountPaths.verify);
    } catch (error) {
      // Registering again soon after a first try (e.g. the verify page was
      // reloaded) hits the SMS cooldown: say how long to wait, then allow it.
      const wait = retryAfterSeconds(error);
      if (wait !== null) {
        setCooldown(wait);
        setBusy(false);
        return;
      }
      const result = formErrors<RegisterField>(error, ERRORS);
      setFields(result.fields);
      setFormError(result.form);
      setBusy(false);
    }
  };

  const error = (field: RegisterField) => (fields[field] ? t(fields[field]) : undefined);

  return (
    <form noValidate onSubmit={submit} className="card mx-3 space-y-3">
      <p className="text-muted">{t('account.register.intro')}</p>
      {formError ? <Alert>{t(formError)}</Alert> : null}
      {cooldown > 0 ? (
        <Alert tone="info">{t('account.errors.otpWait', { seconds: cooldown })}</Alert>
      ) : null}
      <Field
        id="reg-phone"
        label={t('account.fields.phone')}
        hint={t('account.fields.phoneHint')}
        error={error('phone')}
      >
        <PhoneInput
          id="reg-phone"
          name="phone"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          required
          {...describedBy('reg-phone', error('phone'), true)}
        />
      </Field>
      <Field
        id="reg-password"
        label={t('account.fields.pin')}
        hint={t('account.fields.pinHint')}
        error={error('password')}
      >
        <PinInput
          id="reg-password"
          name="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          {...describedBy('reg-password', error('password'), true)}
        />
      </Field>
      <Alert tone="info">{t('account.register.ageNotice')}</Alert>
      <div className="space-y-1">
        <p id="reg-consent" className="text-sm">
          {t('account.register.acceptTerms')}
        </p>
        <Link
          href={routes.terms}
          target="_blank"
          prefetch={false}
          className="inline-block text-xs font-semibold text-brand underline"
        >
          {t('account.register.readTerms')}
        </Link>
        <Link
          href={routes.privacy}
          target="_blank"
          prefetch={false}
          className="ml-3 inline-block text-xs font-semibold text-brand underline"
        >
          {t('account.register.readPrivacy')}
        </Link>
      </div>
      <button
        type="submit"
        className="btn btn-accent w-full"
        disabled={busy || cooldown > 0}
        aria-describedby="reg-consent"
      >
        {busy ? t('common.actions.loading') : t('account.register.submit')}
      </button>
      {IS_DEMO ? (
        <p className="text-center text-xs text-muted">{t('account.register.playMoney')}</p>
      ) : null}
      <p className="border-t border-line pt-3 text-center text-xs">
        {t('account.register.haveAccount')}{' '}
        <Link href={loginHref(next)} className="font-bold text-brand">
          {t('account.register.login')}
        </Link>
      </p>
    </form>
  );
}
