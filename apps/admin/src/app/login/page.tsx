'use client';

import { useState, type FormEvent } from 'react';
import { Field, Notice, PasswordInput, ShowPasswords } from '@/components/ui';
import { useSession } from '@/components/session';
import { describeError } from '@/lib/errors';
import { validateLogin } from '@/lib/forms';

export default function LoginPage() {
  const { login } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const problem = validateLogin({ email, password, code });
    if (problem !== null) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await login({ email: email.trim(), password, code: code.trim() });
    } catch (e) {
      setError(describeError(e));
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <form onSubmit={submit} className="card" autoComplete="off">
        <h1>Vamos Back Office</h1>
        <p className="muted">Staff sign-in</p>
        <Field label="Email">
          <input
            type="email"
            name="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
          />
        </Field>
        <Field label="Password">
          <PasswordInput
            name="password"
            visible={showPassword}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </Field>
        <ShowPasswords checked={showPassword} onChange={setShowPassword} />
        <Field label="Authenticator code">
          <input
            name="code"
            inputMode="numeric"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoComplete="one-time-code"
          />
        </Field>
        {error !== null && <Notice>{error}</Notice>}
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
