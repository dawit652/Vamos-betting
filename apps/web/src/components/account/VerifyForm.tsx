'use client';

import type { MessageKey } from '@vamos/i18n/translate';
import { formatMsisdnLocal } from '@vamos/core';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useSyncExternalStore, type FormEvent } from 'react';
import { useLocale, useT } from '@/i18n/client';
import { authApi } from '@/lib/api/account';
import { formatTime } from '@/lib/format';
import { routes } from '@/lib/routes';
import { useSession } from '@/providers/SessionProvider';
import { formErrors, retryAfterSeconds } from './errors';
import { DemoOtpHint, OtpInput } from './inputs';
import {
  getPendingRegistration,
  setPendingRegistration,
  type PendingRegistration,
} from './pending';
import { Alert, Field, describedBy } from './ui';
import { cleanOtp, otpError } from './validation';

const RESEND_COOLDOWN_S = 60;

const noSubscribe = () => () => {};

const ERRORS = {
  paths: { code: ['code', 'account.validation.otp'] },
  codes: {
    otp_expired: { field: 'code', key: 'account.validation.otpExpired' },
    otp_invalid: { field: 'code', key: 'account.validation.otpInvalid' },
    registration_expired: { key: 'account.errors.registrationExpired' },
  },
} as const;

function displayPhone(phone: string): string {
  try {
    return formatMsisdnLocal(phone);
  } catch {
    return phone;
  }
}

/** Where a new player lands: back to what they were doing, or the wallet to add play money. */
function afterSignUp(next: string): string {
  return next === routes.home ? `${routes.wallet}?welcome=1` : next;
}

export function VerifyForm() {
  // Kept in memory by the register page; null after a reload (server snapshot too).
  const initial = useSyncExternalStore(noSubscribe, getPendingRegistration, () => null);
  const [pending, setPending] = useState<PendingRegistration | null>(null);
  const current = pending ?? initial;
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const session = useSession();
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<MessageKey | undefined>(undefined);
  const [formError, setFormError] = useState<MessageKey | null>(null);
  const [notice, setNotice] = useState<MessageKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(RESEND_COOLDOWN_S);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  if (current === null) {
    return (
      <section className="card mx-3 space-y-3">
        <Alert tone="info">{t('account.verify.missing')}</Alert>
        <Link href={routes.register} className="btn btn-accent w-full">
          {t('account.verify.restart')}
        </Link>
      </section>
    );
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const local = otpError(code);
    setCodeError(local);
    setFormError(null);
    setNotice(null);
    if (local) return;
    setBusy(true);
    try {
      await authApi.verifyOtp({
        phone: current.phone,
        code,
        purpose: 'register',
        registrationToken: current.registrationToken,
      });
      setPendingRegistration(null);
      await session.refresh();
      router.replace(afterSignUp(current.next));
    } catch (error) {
      const result = formErrors<'code'>(error, ERRORS);
      setCodeError(result.fields.code);
      setFormError(result.form);
      setBusy(false);
    }
  };

  const resend = async () => {
    if (busy || cooldown > 0) return;
    setBusy(true);
    setFormError(null);
    setNotice(null);
    try {
      const sent = await authApi.resendOtp({
        phone: current.phone,
        purpose: 'register',
        registrationToken: current.registrationToken,
      });
      const updated: PendingRegistration = {
        ...current,
        otpSentTo: sent.otpSentTo,
        otpExpiresAt: sent.otpExpiresAt,
        demoOtp: sent.demoOtp ?? null,
      };
      setPendingRegistration(updated);
      setPending(updated);
      setNotice('account.verify.resent');
      setCooldown(RESEND_COOLDOWN_S);
    } catch (error) {
      const wait = retryAfterSeconds(error);
      if (wait !== null) setCooldown(wait);
      else setFormError(formErrors<'code'>(error, ERRORS).form);
    } finally {
      setBusy(false);
    }
  };

  const errorText = codeError ? t(codeError) : undefined;
  return (
    <form noValidate onSubmit={submit} className="card mx-3 space-y-3">
      <p>{t('account.verify.intro', { phone: displayPhone(current.phone) })}</p>
      <p className="text-xs text-muted">
        {t('account.verify.expires', { time: formatTime(current.otpExpiresAt, locale) })}
      </p>
      <DemoOtpHint
        phone={current.phone}
        demoOtp={current.demoOtp}
        onUse={(demo) => {
          setCode(demo);
          setCodeError(undefined);
        }}
      />
      {formError ? (
        <Alert>
          {t(formError)}{' '}
          {formError === 'account.errors.registrationExpired' ? (
            <Link href={routes.register} className="underline">
              {t('account.verify.restart')}
            </Link>
          ) : null}
        </Alert>
      ) : null}
      {notice ? <Alert tone="success">{t(notice)}</Alert> : null}
      <Field id="otp-code" label={t('account.fields.code')} error={errorText}>
        <OtpInput
          id="otp-code"
          name="code"
          value={code}
          onChange={(e) => setCode(cleanOtp(e.target.value))}
          required
          autoFocus
          {...describedBy('otp-code', errorText)}
        />
      </Field>
      <button type="submit" className="btn btn-primary w-full" disabled={busy}>
        {busy ? t('common.actions.loading') : t('account.verify.submit')}
      </button>
      <button
        type="button"
        className="btn btn-outline w-full"
        disabled={busy || cooldown > 0}
        onClick={() => void resend()}
      >
        {cooldown > 0
          ? t('account.verify.resendIn', { seconds: cooldown })
          : t('account.verify.resend')}
      </button>
    </form>
  );
}
