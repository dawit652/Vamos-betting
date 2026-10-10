import Link from 'next/link';
import type { ReactNode } from 'react';
import { TONE_CLASS, type Tone } from './bets';

/**
 * Small presentational pieces shared by the account pages. No hooks, so both
 * server and client components can use them.
 */

export function PageTitle({ children, back }: { children: ReactNode; back?: ReactNode }) {
  return (
    <div className="px-3 pt-3 pb-2">
      {back}
      <h1 className="text-lg font-bold">{children}</h1>
    </div>
  );
}

export function BackLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      prefetch={false}
      className="mb-1 inline-block text-xs font-semibold text-brand"
    >
      ‹ {children}
    </Link>
  );
}

export function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-xs font-semibold">
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="text-xs font-semibold text-down">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** aria props tying an input to the message rendered by <Field>. */
export function describedBy(id: string, error: string | undefined, hint?: boolean) {
  if (error) return { 'aria-invalid': true, 'aria-describedby': `${id}-error` } as const;
  return hint ? ({ 'aria-describedby': `${id}-hint` } as const) : {};
}

export function Alert({
  tone = 'error',
  children,
}: {
  tone?: 'error' | 'success' | 'info' | 'demo';
  children: ReactNode;
}) {
  const styles = {
    error: 'border-down/40 bg-down/10 text-down',
    success: 'border-up/40 bg-up/10 text-up',
    info: 'border-line bg-brand-soft text-ink',
    demo: 'border-accent-strong/40 bg-demo-bg text-demo-ink',
  }[tone];
  return (
    <p
      role={tone === 'error' ? 'alert' : 'status'}
      className={`rounded border px-3 py-2 text-xs font-semibold ${styles}`}
    >
      {children}
    </p>
  );
}

export function Chip({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-xxs font-bold uppercase ${TONE_CLASS[tone]}`}
    >
      {children}
    </span>
  );
}

export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="card m-3 space-y-2" aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="h-4 animate-pulse rounded bg-line" />
      ))}
    </div>
  );
}

/** One "label … value" line of a summary. */
export function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <dt className="text-muted">{label}</dt>
      <dd className="text-right font-semibold tabular-nums">{children}</dd>
    </div>
  );
}

export function MenuLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <li>
      <Link
        href={href}
        prefetch={false}
        className="flex min-h-11 items-center justify-between border-b border-line px-3 py-2 font-semibold last:border-b-0"
      >
        <span>{children}</span>
        <span aria-hidden="true" className="text-muted">
          ›
        </span>
      </Link>
    </li>
  );
}
