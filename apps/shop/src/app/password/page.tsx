'use client';

import type { ShopPasswordChangeRequest } from '@vamos/contracts';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { useSession } from '@/components/session';
import { api } from '@/lib/api';
import { describeError } from '@/lib/errors';
import { passwordChangeProblem } from '@/lib/forms';
import { TEXT } from '@/lib/text';

export default function PasswordPage() {
  const { session, refresh } = useSession();
  const router = useRouter();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const problem = passwordChangeProblem(next, repeat);
    if (problem !== null) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    const body: ShopPasswordChangeRequest = { currentPassword: current, newPassword: next };
    try {
      await api<{ ok: true }>('/shop/auth/password', { method: 'POST', body });
      // The session no longer asks for a change; the guard would send us away from here anyway.
      await refresh();
      router.replace('/');
    } catch (e) {
      setError(describeError(e, TEXT.passwordErrors));
      setBusy(false);
    }
  }

  return (
    <div className="card narrow">
      <h1>{TEXT.passwordTitle}</h1>
      <p className={session?.staff.passwordChangeRequired === true ? 'notice' : 'muted'}>
        {session?.staff.passwordChangeRequired === true ? TEXT.passwordForced : TEXT.passwordHint}
      </p>
      <form onSubmit={(e) => void submit(e)} aria-label="Change password">
        <label htmlFor="current">
          {TEXT.currentPassword}
          <input
            id="current"
            type="password"
            autoComplete="current-password"
            required
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </label>
        <label htmlFor="new">
          {TEXT.newPassword}
          <input
            id="new"
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            maxLength={128}
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
        </label>
        <label htmlFor="repeat">
          {TEXT.repeatPassword}
          <input
            id="repeat"
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            maxLength={128}
            value={repeat}
            onChange={(e) => setRepeat(e.target.value)}
          />
        </label>
        {error === null ? null : (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="primary" disabled={busy}>
          {busy ? TEXT.passwordSaving : TEXT.passwordSave}
        </button>
      </form>
    </div>
  );
}
