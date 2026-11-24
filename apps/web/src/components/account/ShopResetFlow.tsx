'use client';

import type { ShopPinResetState } from '@vamos/contracts';
import type { MessageKey } from '@vamos/i18n/translate';
import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { useLocale, useT } from '@/i18n/client';
import { authApi } from '@/lib/api/account';
import { isApiClientError } from '@/lib/api/errors';
import { routes } from '@/lib/routes';
import { useSession } from '@/providers/SessionProvider';
import { formatDateTime } from './dates';
import { formErrors } from './errors';
import { PhoneInput, PinInput } from './inputs';
import {
  clearShopReset,
  formatDeskCode,
  loadShopReset,
  newShopResetSecret,
  saveShopReset,
  shopResetSecretHash,
  type ShopResetRecord,
} from './shop-reset';
import { Alert, Field, describedBy } from './ui';
import { hasErrors, normalizePhone, phoneError, pinError, type FieldErrors } from './validation';

/** How often the phone asks where its request is while the shop works on it. */
const POLL_MS = 5_000;

type PinField = 'newPassword' | 'confirmPassword';

const START_ERRORS = {
  paths: { phone: ['phone', 'account.validation.phone'] },
  codes: {
    invalid_phone: { field: 'phone', key: 'account.validation.phone' },
    pin_reset_limit: { key: 'account.shopReset.limit' },
    rate_limited: { key: 'account.shopReset.limit' },
  },
} as const;

const PIN_ERRORS = {
  paths: { newPassword: ['newPassword', 'account.validation.pinFormat'] },
  codes: { weak_password: { field: 'newPassword', key: 'account.validation.weakPassword' } },
} as const;

/**
 * "Reset at a shop" (no SMS or Telegram): the phone makes a secret and shows the desk code; the
 * cashier checks the Fayda ID; a supervisor approves; then only this browser sets the new PIN.
 */
export function ShopResetFlow() {
  const t = useT();
  const locale = useLocale();
  const session = useSession();
  const [loaded, setLoaded] = useState(false);
  const [record, setRecord] = useState<ShopResetRecord | null>(null);
  const [state, setState] = useState<ShopPinResetState | null>(null);
  const [until, setUntil] = useState<string | null>(null);
  const [phone, setPhone] = useState('');
  const [phoneFieldError, setPhoneFieldError] = useState<MessageKey | undefined>(undefined);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pinFields, setPinFields] = useState<FieldErrors<PinField>>({});
  const [formError, setFormError] = useState<MessageKey | null>(null);
  const [busy, setBusy] = useState(false);

  // A reset started earlier on this phone (the page may have been closed on the way to the shop).
  useEffect(() => {
    setRecord(loadShopReset());
    setLoaded(true);
  }, []);

  const waiting = record !== null && (state === null || state.startsWith('waiting'));
  useEffect(() => {
    if (!waiting || record === null) return;
    let stopped = false;
    const ask = async () => {
      try {
        const status = await authApi.shopResetStatus({ secret: record.secret });
        if (stopped) return;
        setState(status.state);
        setUntil(status.until);
      } catch (error) {
        if (stopped) return;
        // Unknown to the server: start again (a network error just waits for the next try).
        if (isApiClientError(error) && error.status === 404) {
          clearShopReset();
          setRecord(null);
          setState(null);
          setFormError('account.shopReset.lost');
        }
      }
    };
    void ask();
    const timer = window.setInterval(() => void ask(), POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [waiting, record]);

  const startAgain = () => {
    clearShopReset();
    setRecord(null);
    setState(null);
    setUntil(null);
    setNewPassword('');
    setConfirmPassword('');
    setPinFields({});
    setFormError(null);
  };

  const start = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const invalid = phoneError(phone);
    setPhoneFieldError(invalid);
    setFormError(null);
    if (invalid !== undefined) return;
    setBusy(true);
    try {
      const normalized = normalizePhone(phone) ?? phone;
      const secret = newShopResetSecret();
      const started = await authApi.shopResetStart({
        phone: normalized,
        secretHash: await shopResetSecretHash(secret),
      });
      const kept: ShopResetRecord = {
        secret,
        phone: normalized,
        deskCode: started.deskCode,
        expiresAt: started.expiresAt,
      };
      saveShopReset(kept);
      setState(null);
      setUntil(started.expiresAt);
      setRecord(kept);
    } catch (error) {
      const result = formErrors<'phone'>(error, START_ERRORS);
      setPhoneFieldError(result.fields.phone);
      setFormError(result.form);
    } finally {
      setBusy(false);
    }
  };

  const complete = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || record === null) return;
    const local: FieldErrors<PinField> = {};
    const invalid = pinError(newPassword, record.phone);
    if (invalid !== undefined) local.newPassword = invalid;
    else if (confirmPassword !== newPassword) {
      local.confirmPassword = 'account.validation.passwordMismatch';
    }
    setPinFields(local);
    setFormError(null);
    if (hasErrors(local)) return;
    setBusy(true);
    try {
      await authApi.shopResetComplete({ secret: record.secret, newPassword });
      clearShopReset();
      setState('done');
      // Every session of the account was revoked, this device's included.
      await session.refresh();
    } catch (error) {
      const code = isApiClientError(error) ? error.code : null;
      if (code === 'pin_reset_expired') setState('expired');
      else if (code === 'pin_reset_used') setState('done');
      else if (code === 'pin_reset_not_approved') setState(null);
      else {
        const result = formErrors<PinField>(error, PIN_ERRORS);
        setPinFields(result.fields);
        setFormError(result.form);
      }
    } finally {
      setBusy(false);
    }
  };

  if (!loaded) return null;

  if (record === null) {
    return (
      <form method="post" noValidate onSubmit={start} className="card mx-3 space-y-3">
        <p className="text-muted">{t('account.shopReset.intro')}</p>
        {formError ? <Alert>{t(formError)}</Alert> : null}
        <Field
          id="shop-reset-phone"
          label={t('account.fields.phone')}
          error={phoneFieldError ? t(phoneFieldError) : undefined}
        >
          <PhoneInput
            id="shop-reset-phone"
            name="phone"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            required
            {...describedBy('shop-reset-phone', phoneFieldError ? t(phoneFieldError) : undefined)}
          />
        </Field>
        <button type="submit" className="btn btn-primary w-full" disabled={busy}>
          {busy ? t('common.actions.loading') : t('account.shopReset.start')}
        </button>
      </form>
    );
  }

  const shownUntil = until ?? record.expiresAt;
  const pinFieldError = (field: PinField) => (pinFields[field] ? t(pinFields[field]) : undefined);
  return (
    <section className="card mx-3 space-y-3" aria-live="polite" data-testid="shop-reset">
      {state === null || state === 'waiting_desk' || state === 'waiting_approval' ? (
        <>
          <h2 className="font-bold">{t('account.shopReset.codeTitle')}</h2>
          <p
            className="text-center text-3xl font-bold tracking-widest"
            data-testid="shop-reset-code"
          >
            {formatDeskCode(record.deskCode)}
          </p>
          <p className="text-sm text-muted">{t('account.shopReset.codeHelp')}</p>
          <p className="text-xs text-muted">
            {t('account.shopReset.validUntil', { time: formatDateTime(shownUntil, locale) })}
          </p>
          <Alert tone="info">
            <span data-testid="shop-reset-state">
              {t(
                state === 'waiting_approval'
                  ? 'account.shopReset.waitingApproval'
                  : 'account.shopReset.waitingDesk',
              )}
            </span>
          </Alert>
        </>
      ) : null}

      {state === 'approved' ? (
        <form method="post" noValidate onSubmit={complete} className="space-y-3">
          <Alert tone="success">
            <span data-testid="shop-reset-state">{t('account.shopReset.approved')}</span>
          </Alert>
          {formError ? <Alert>{t(formError)}</Alert> : null}
          <Field
            id="shop-reset-pin"
            label={t('account.fields.newPin')}
            hint={t('account.fields.pinHint')}
            error={pinFieldError('newPassword')}
          >
            <PinInput
              id="shop-reset-pin"
              name="newPassword"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
              {...describedBy('shop-reset-pin', pinFieldError('newPassword'), true)}
            />
          </Field>
          <Field
            id="shop-reset-confirm"
            label={t('account.fields.confirmPin')}
            error={pinFieldError('confirmPassword')}
          >
            <PinInput
              id="shop-reset-confirm"
              name="confirmPassword"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              {...describedBy('shop-reset-confirm', pinFieldError('confirmPassword'))}
            />
          </Field>
          <button type="submit" className="btn btn-primary w-full" disabled={busy}>
            {busy ? t('common.actions.loading') : t('account.shopReset.submit')}
          </button>
        </form>
      ) : null}

      {state === 'rejected' || state === 'expired' ? (
        <>
          <Alert>
            <span data-testid="shop-reset-state">
              {t(state === 'rejected' ? 'account.shopReset.rejected' : 'account.shopReset.expired')}
            </span>
          </Alert>
          <button type="button" className="btn btn-outline w-full" onClick={startAgain}>
            {t('account.shopReset.startAgain')}
          </button>
        </>
      ) : null}

      {state === 'done' ? (
        <>
          <Alert tone="success">
            <span data-testid="shop-reset-state">{t('account.shopReset.done')}</span>
          </Alert>
          <Link
            href={`${routes.login}?reset=1`}
            className="btn btn-primary w-full"
            onClick={clearShopReset}
          >
            {t('account.shopReset.logIn')}
          </Link>
        </>
      ) : null}
    </section>
  );
}
