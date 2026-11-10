'use client';

import type { KycResponse } from '@vamos/contracts';
import type { MessageKey } from '@vamos/i18n/translate';
import { useEffect, useState, type FormEvent } from 'react';
import { useT } from '@/i18n/client';
import { accountApi } from '@/lib/api/account';
import { errorMessageKey } from '@/lib/api/errors';
import { IS_DEMO } from '@/lib/mode';
import { useSession } from '@/providers/SessionProvider';
import { KYC_LABEL, KYC_TONE } from './kyc';
import { formErrors } from './errors';
import { Alert, Chip, Field, Skeleton, describedBy } from './ui';
import {
  hasErrors,
  normalizeFaydaId,
  validateKyc,
  type FieldErrors,
  type KycInput,
} from './validation';

type KycField = keyof KycInput;

const ERRORS = {
  paths: {
    idNumber: ['idNumber', 'account.validation.fayda'],
    fullName: ['fullName', 'account.validation.fullName'],
    dateOfBirth: ['dateOfBirth', 'account.validation.dateOfBirth'],
  },
  codes: {
    invalid_date_of_birth: { field: 'dateOfBirth', key: 'account.validation.dateOfBirth' },
    kyc_already_verified: { key: 'account.kyc.alreadyVerified' },
    id_already_used: { field: 'idNumber', key: 'account.kyc.idAlreadyUsed' },
    kyc_unavailable: { key: 'account.kyc.unavailable' },
    underage: { key: 'account.kyc.underage' },
  },
} as const;

function KycForm({ onResult }: { onResult: (result: KycResponse) => void }) {
  const t = useT();
  const session = useSession();
  const [idNumber, setIdNumber] = useState('');
  const [fullName, setFullName] = useState(session.me?.fullName ?? '');
  const [dateOfBirth, setDateOfBirth] = useState(session.me?.dateOfBirth ?? '');
  const [fields, setFields] = useState<FieldErrors<KycField>>({});
  const [formError, setFormError] = useState<MessageKey | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const local = validateKyc({ idNumber, fullName, dateOfBirth }, new Date());
    setFields(local);
    setFormError(null);
    if (hasErrors(local)) return;
    setBusy(true);
    try {
      const result = await accountApi.submitKyc({
        idNumber: normalizeFaydaId(idNumber) ?? idNumber,
        fullName: fullName.trim(),
        dateOfBirth,
      });
      onResult(result);
      // The profile shows the KYC status (and a verified name).
      void session.refresh();
    } catch (error) {
      // An underage finding suspends the account and signs it out; the message
      // stays on screen (the session is not refreshed here on purpose).
      const result = formErrors<KycField>(error, ERRORS);
      setFields(result.fields);
      setFormError(result.form);
    } finally {
      setBusy(false);
    }
  };

  const error = (field: KycField) => (fields[field] ? t(fields[field]) : undefined);
  return (
    <form noValidate onSubmit={submit} className="space-y-3">
      {formError ? <Alert>{t(formError)}</Alert> : null}
      <Field
        id="kyc-id"
        label={t('account.kyc.idNumber')}
        hint={t('account.kyc.idHint')}
        error={error('idNumber')}
      >
        <input
          id="kyc-id"
          name="idNumber"
          className="input tabular-nums"
          inputMode="numeric"
          autoComplete="off"
          maxLength={24}
          value={idNumber}
          onChange={(e) => setIdNumber(e.target.value)}
          required
          {...describedBy('kyc-id', error('idNumber'), true)}
        />
      </Field>
      <Field id="kyc-name" label={t('account.fields.fullName')} error={error('fullName')}>
        <input
          id="kyc-name"
          name="fullName"
          className="input"
          autoComplete="name"
          maxLength={120}
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          required
          {...describedBy('kyc-name', error('fullName'))}
        />
      </Field>
      <Field id="kyc-dob" label={t('account.fields.dateOfBirth')} error={error('dateOfBirth')}>
        <input
          id="kyc-dob"
          name="dateOfBirth"
          type="date"
          className="input"
          min="1900-01-01"
          value={dateOfBirth}
          onChange={(e) => setDateOfBirth(e.target.value)}
          required
          {...describedBy('kyc-dob', error('dateOfBirth'))}
        />
      </Field>
      <button type="submit" className="btn btn-primary w-full" disabled={busy}>
        {busy ? t('common.actions.loading') : t('account.kyc.submit')}
      </button>
    </form>
  );
}

export function KycView() {
  const t = useT();
  const [kyc, setKyc] = useState<KycResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const abort = new AbortController();
    setError(null);
    accountApi.kyc(abort.signal).then(
      (result) => {
        if (!abort.signal.aborted) setKyc(result);
      },
      (err: unknown) => {
        if (!abort.signal.aborted) setError(err);
      },
    );
    return () => abort.abort();
  }, [attempt]);

  if (error !== null && kyc === null) {
    return (
      <div className="space-y-2 px-3">
        <Alert>{t(errorMessageKey(error))}</Alert>
        <button
          type="button"
          className="btn btn-outline w-full"
          onClick={() => setAttempt((n) => n + 1)}
        >
          {t('common.actions.retry')}
        </button>
      </div>
    );
  }
  if (kyc === null) return <Skeleton lines={4} />;

  const canSubmit = kyc.status === 'unverified' || kyc.status === 'rejected';
  return (
    <div className="space-y-3 px-3">
      <section className="card space-y-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-muted">{t('account.overview.identity')}</p>
          <Chip tone={KYC_TONE[kyc.status]}>{t(KYC_LABEL[kyc.status])}</Chip>
        </div>
        {kyc.status === 'pending' ? (
          <Alert tone="info">{t('account.kyc.pendingBody')}</Alert>
        ) : null}
        {kyc.status === 'verified' ? (
          <Alert tone="success">
            {t('account.kyc.verifiedBody', { last4: kyc.idNumberLast4 ?? '····' })}
          </Alert>
        ) : null}
        {kyc.status === 'rejected' ? (
          <Alert>
            {kyc.rejectionReason
              ? t('account.kyc.rejectedBody', { reason: kyc.rejectionReason })
              : t('account.kyc.rejectedRetry')}
          </Alert>
        ) : null}
        {canSubmit ? (
          <>
            <p className="text-sm">{t('account.kyc.intro')}</p>
            {IS_DEMO ? <Alert tone="demo">{t('account.kyc.demoNote')}</Alert> : null}
            <KycForm onResult={setKyc} />
          </>
        ) : null}
      </section>
    </div>
  );
}
