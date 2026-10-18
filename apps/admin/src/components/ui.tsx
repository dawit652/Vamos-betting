'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import { describeError } from '@/lib/errors';
import { validateReason } from '@/lib/forms';

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="page-head">
      <h1>{title}</h1>
      <div className="row">{children}</div>
    </div>
  );
}

export function Notice({
  kind = 'error',
  children,
}: {
  kind?: 'error' | 'ok' | 'info';
  children: ReactNode;
}) {
  return (
    <p className={`notice ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {children}
    </p>
  );
}

export function Badge({
  value,
  tone,
}: {
  value: string;
  tone?: 'good' | 'warn' | 'bad' | 'muted';
}) {
  const auto =
    tone ??
    ([
      'won',
      'verified',
      'active',
      'paid',
      'completed',
      'open',
      'settled',
      'finished',
      'approved',
    ].includes(value)
      ? 'good'
      : ['lost', 'rejected', 'failed', 'suspended', 'void', 'cancelled', 'closed'].includes(value)
        ? 'bad'
        : ['pending', 'requested', 'processing', 'live', 'review'].includes(value)
          ? 'warn'
          : 'muted');
  return <span className={`badge ${auto}`}>{value.replace(/_/g, ' ')}</span>;
}

export function Loading({ loading, error }: { loading: boolean; error: string | null }) {
  if (error !== null) return <Notice>{error}</Notice>;
  return loading ? <p className="muted">Loading…</p> : null;
}

export function LoadMore({
  hasMore,
  loading,
  onMore,
}: {
  hasMore: boolean;
  loading: boolean;
  onMore: () => void;
}) {
  if (!hasMore) return null;
  return (
    <p>
      <button type="button" onClick={onMore} disabled={loading}>
        {loading ? 'Loading…' : 'Load more'}
      </button>
    </p>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {hint !== undefined && <div className="muted small">{hint}</div>}
    </div>
  );
}

export function DefList({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="deflist">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * A button that opens a small inline form for a reason (or note) before it acts. `onSubmit`
 * rejects with an ApiClientError to show the failure inline; success closes the form.
 */
export function ReasonAction({
  label,
  submitLabel,
  danger,
  optional,
  prompt = 'Reason',
  onSubmit,
}: {
  label: string;
  submitLabel?: string;
  danger?: boolean;
  optional?: boolean;
  prompt?: string;
  onSubmit: (reason: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const problem = optional === true && reason.trim() === '' ? null : validateReason(reason);
    if (problem !== null) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(reason.trim());
      setOpen(false);
      setReason('');
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        className={danger === true ? 'danger' : ''}
        onClick={() => setOpen(true)}
      >
        {label}
      </button>
    );
  }
  return (
    <form className="inline-form" onSubmit={submit}>
      <input
        aria-label={prompt}
        placeholder={prompt}
        value={reason}
        maxLength={500}
        onChange={(e) => setReason(e.target.value)}
        autoFocus
      />
      <button type="submit" className={danger === true ? 'danger' : 'primary'} disabled={busy}>
        {submitLabel ?? label}
      </button>
      <button type="button" onClick={() => setOpen(false)} disabled={busy}>
        Cancel
      </button>
      {error !== null && <Notice>{error}</Notice>}
    </form>
  );
}

/** A plain action button that reports its failure inline. */
export function ActionButton({
  label,
  primary,
  onAction,
}: {
  label: string;
  primary?: boolean;
  onAction: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span>
      <button
        type="button"
        className={primary === true ? 'primary' : ''}
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          onAction()
            .catch((e: unknown) => setError(describeError(e)))
            .finally(() => setBusy(false));
        }}
      >
        {label}
      </button>
      {error !== null && <Notice>{error}</Notice>}
    </span>
  );
}
