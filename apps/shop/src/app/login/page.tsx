'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { useSession } from '@/components/session';
import { ApiClientError, describeError } from '@/lib/errors';
import { TEXT } from '@/lib/text';

export default function LoginPage() {
  const { login } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login({ email, password });
    } catch (e) {
      // The API answers 401 for anything wrong, a device not approved yet included.
      setError(
        e instanceof ApiClientError && e.status === 401 ? TEXT.loginFailed : describeError(e),
      );
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h1>{TEXT.appName}</h1>
      <form onSubmit={(e) => void submit(e)} aria-label="Sign in">
        <label htmlFor="email">
          {TEXT.email}
          <input
            id="email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label htmlFor="password">
          {TEXT.password}
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error === null ? null : (
          <p className="error" role="alert">
            {error}{' '}
            {error === TEXT.loginFailed ? (
              <Link href="/register-device">{TEXT.registerDeviceLink}</Link>
            ) : null}
          </p>
        )}
        <button type="submit" className="primary" disabled={busy}>
          {busy ? TEXT.signingIn : TEXT.signIn}
        </button>
      </form>
      <p>
        <Link href="/register-device">{TEXT.registerDeviceLink}</Link>
      </p>
    </div>
  );
}
