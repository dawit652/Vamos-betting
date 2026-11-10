'use client';

import type { MessageKey } from '@vamos/i18n/translate';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { useLocale, useT } from '@/i18n/client';
import { authApi } from '@/lib/api/account';
import { routes } from '@/lib/routes';
import { useSession } from '@/providers/SessionProvider';
import { formatBirthDate } from './dates';
import { formErrors, retryAfterSeconds } from './errors';
import { PasswordInput, PasswordStrengthMeter, PhoneInput } from './inputs';
import { accountPaths, afterSignUp, loginHref } from './paths';
import { setPendingRegistration } from './pending';
import { Alert, Field, describedBy } from './ui';
import {
  MIN_PASSWORD_LENGTH,
  hasErrors,
  latestBirthDate,
  normalizePhone,
  validateRegister,
  type FieldErrors,
  type RegisterField,
} from './validation';

const ERRORS = {
  paths: {
    phone: ['phone', 'account.validation.phone'],
    password: ['password', 'account.validation.passwordShort'],
    dateOfBirth: ['dateOfBirth', 'account.validation.dateOfBirth'],
    acceptTerms: ['acceptTerms', 'account.validation.terms'],
  },
  codes: {
    invalid_phone: { field: 'phone', key: 'account.validation.phone' },
    phone_taken: { field: 'phone', key: 'account.errors.phoneTaken' },
    weak_password: { field: 'password', key: 'account.validation.weakPassword' },
    invalid_date_of_birth: { field: 'dateOfBirth', key: 'account.validation.dateOfBirth' },
    underage: { field: 'dateOfBirth', key: 'account.validation.underage' },
  },
} as const;

export function RegisterForm({ next }: { next: string }) {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const session = useSession();
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [fields, setFields] = useState<FieldErrors<RegisterField>>({});
  const [formError, setFormError] = useState<MessageKey | null>(null);
  const [busy, setBusy] = useState(false);
  // Seconds until the API sends another code (after a 429 otp_cooldown / otp_limit).
  const [cooldown, setCooldown] = useState(0);
  // The date input's max (the latest birth date that is 21 today), set after mount
  // so server and client render the same markup.
  const [maxBirthDate, setMaxBirthDate] = useState<string | null>(null);

  useEffect(() => {
    setMaxBirthDate(latestBirthDate(new Date()));
  }, []);

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
    const local = validateRegister({ phone, password, dateOfBirth, acceptTerms }, new Date());
    setFields(local);
    setFormError(null);
    if (hasErrors(local)) return;
    const normalized = normalizePhone(phone) ?? phone;
    setBusy(true);
    try {
      const response = await authApi.register({
        phone: normalized,
        password,
        dateOfBirth,
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
        label={t('account.fields.password')}
        hint={t('account.fields.passwordHint')}
        error={error('password')}
      >
        <PasswordInput
          id="reg-password"
          name="password"
          autoComplete="new-password"
          minLength={MIN_PASSWORD_LENGTH}
          maxLength={128}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          {...describedBy('reg-password', error('password'), true)}
        />
        <PasswordStrengthMeter password={password} />
      </Field>
      <Field
        id="reg-dob"
        label={t('account.fields.dateOfBirth')}
        hint={
          maxBirthDate
            ? t('account.register.dobHint', { date: formatBirthDate(maxBirthDate, locale) })
            : undefined
        }
        error={error('dateOfBirth')}
      >
        <input
          id="reg-dob"
          name="dateOfBirth"
          type="date"
          className="input"
          autoComplete="bday"
          min="1900-01-01"
          max={maxBirthDate ?? undefined}
          value={dateOfBirth}
          onChange={(e) => setDateOfBirth(e.target.value)}
          required
          {...describedBy('reg-dob', error('dateOfBirth'), maxBirthDate !== null)}
        />
      </Field>
      <Alert tone="info">{t('account.register.ageNotice')}</Alert>
      <div className="space-y-1">
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            name="acceptTerms"
            className="mt-0.5 size-5 flex-none accent-brand"
            checked={acceptTerms}
            onChange={(e) => setAcceptTerms(e.target.checked)}
            {...describedBy('reg-terms', error('acceptTerms'))}
          />
          <span>{t('account.register.acceptTerms')}</span>
        </label>
        {error('acceptTerms') ? (
          <p id="reg-terms-error" className="text-xs font-semibold text-down">
            {error('acceptTerms')}
          </p>
        ) : null}
        <Link
          href={routes.terms}
          target="_blank"
          prefetch={false}
          className="ml-7 inline-block text-xs font-semibold text-brand underline"
        >
          {t('account.register.readTerms')}
        </Link>
        <Link
          href={routes.privacy}
          target="_blank"
          prefetch={false}
          className="ml-7 inline-block text-xs font-semibold text-brand underline"
        >
          {t('account.register.readPrivacy')}
        </Link>
      </div>
      <button type="submit" className="btn btn-accent w-full" disabled={busy || cooldown > 0}>
        {busy ? t('common.actions.loading') : t('account.register.submit')}
      </button>
      <p className="text-center text-xs text-muted">{t('account.register.playMoney')}</p>
      <p className="border-t border-line pt-3 text-center text-xs">
        {t('account.register.haveAccount')}{' '}
        <Link href={loginHref(next)} className="font-bold text-brand">
          {t('account.register.login')}
        </Link>
      </p>
    </form>
  );
}
