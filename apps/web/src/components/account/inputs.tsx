'use client';

import { useState, type InputHTMLAttributes } from 'react';
import { useT } from '@/i18n/client';
import { PUBLIC_API_URL } from '@/lib/api/config';
import { Alert } from './ui';
import { PIN_LENGTH } from './validation';

type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'className'>;

/** Password input with a show/hide toggle (see PinInput for a new PIN). */
export function PasswordInput(props: InputProps) {
  const t = useT();
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <input
        {...props}
        type={visible ? 'text' : 'password'}
        className="input pr-12"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
      />
      <button
        type="button"
        className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-muted"
        aria-label={t('account.fields.showPassword')}
        aria-pressed={visible}
        onClick={() => setVisible((v) => !v)}
      >
        <svg
          viewBox="0 0 24 24"
          width="20"
          height="20"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
          <circle cx="12" cy="12" r="3" />
          {visible ? null : <path d="M4 20 20 4" />}
        </svg>
      </button>
    </div>
  );
}

/** A new PIN: four digits, numeric keypad, with the show/hide toggle. */
export function PinInput(props: InputProps) {
  return <PasswordInput {...props} inputMode="numeric" pattern="[0-9]*" maxLength={PIN_LENGTH} />;
}

/** Phone input: numeric keypad, local or international format. */
export function PhoneInput(props: InputProps) {
  return (
    <input
      {...props}
      type="tel"
      inputMode="tel"
      autoComplete="tel"
      placeholder="09XX XXX XXX"
      className="input"
      maxLength={20}
    />
  );
}

/** Six-digit SMS code input (lets the phone autofill the code). */
export function OtpInput(props: InputProps) {
  return (
    <input
      {...props}
      type="text"
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="[0-9]*"
      maxLength={6}
      placeholder="••••••"
      className="input text-center text-lg tracking-[0.5em] tabular-nums"
    />
  );
}

/** The dev SMS inbox of the API exists only outside production builds. */
const DEV_INBOX = process.env.NODE_ENV !== 'production';

/**
 * Demo-mode note under an SMS code field: no SMS is really sent. Shows the
 * code when the API echoed it (registration in demo mode) and, in development,
 * a link to the API's dev SMS inbox (GET /dev/sms?phone=…).
 */
export function DemoOtpHint({
  phone,
  demoOtp,
  onUse,
}: {
  phone: string | null;
  demoOtp?: string | null;
  onUse?: (code: string) => void;
}) {
  const t = useT();
  if (!demoOtp && !DEV_INBOX) return null;
  const inbox =
    DEV_INBOX && phone ? `${PUBLIC_API_URL}/dev/sms?phone=${encodeURIComponent(phone)}` : null;
  return (
    <Alert tone="demo">
      {demoOtp ? (
        <>
          {t('account.demo.smsNotice')} {t('account.demo.code', { code: demoOtp })}{' '}
          {onUse ? (
            <button type="button" className="underline" onClick={() => onUse(demoOtp)}>
              {t('account.demo.useCode')}
            </button>
          ) : null}
        </>
      ) : (
        t('account.demo.inboxHint')
      )}
      {inbox ? (
        <>
          {' '}
          <a href={inbox} target="_blank" rel="noreferrer" className="underline">
            {t('account.demo.devInbox')}
          </a>
        </>
      ) : null}
    </Alert>
  );
}
