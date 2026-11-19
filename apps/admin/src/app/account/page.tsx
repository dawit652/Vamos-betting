'use client';

import type {
  RevokeOwnStaffSessionsResponse,
  StaffOwnSessionsResponse,
  TotpEnrolmentView,
} from '@vamos/contracts';
import { useState, type FormEvent } from 'react';
import { useFetch } from '@/components/hooks';
import { useSession } from '@/components/session';
import {
  Field,
  Loading,
  Notice,
  PageHeader,
  PasswordInput,
  PasswordStrengthHint,
  ShowPasswords,
} from '@/components/ui';
import { api } from '@/lib/api';
import { describeError } from '@/lib/errors';
import { deviceLabel, formatDateTime } from '@/lib/format';
import { validateCode, validatePasswordChange } from '@/lib/forms';

/** The signed-in staff member's own password, authenticator app and sessions. */
export default function AccountPage() {
  const { staff } = useSession();
  return (
    <>
      <PageHeader title="My account" />
      {staff?.passwordChangeRequired === true && (
        <Notice kind="info">
          Your password was set by someone else. Choose a password of your own to continue, and
          consider moving your authenticator to a new secret below.
        </Notice>
      )}
      <PasswordForm />
      <AuthenticatorForm />
      <SessionsCard />
    </>
  );
}

function PasswordForm() {
  const { refresh } = useSession();
  const [currentPassword, setCurrentPassword] = useState('');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPasswords, setShowPasswords] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const input = { currentPassword, code, newPassword, confirmPassword };
    const problem = validatePasswordChange(input);
    setDone(false);
    if (problem !== null) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api('/admin/me/password', {
        method: 'POST',
        body: { currentPassword, code: code.trim(), newPassword },
      });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setDone(true);
      await refresh();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setCode('');
      setBusy(false);
    }
  }

  return (
    <form
      method="post"
      onSubmit={submit}
      className="card"
      autoComplete="off"
      aria-label="Change password"
    >
      <h2>Change password</h2>
      <p className="muted small">Your other sessions are signed out.</p>
      <Field label="Current password">
        <PasswordInput
          visible={showPasswords}
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          autoComplete="current-password"
        />
      </Field>
      <Field label="Authenticator code">
        <input
          inputMode="numeric"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoComplete="one-time-code"
        />
      </Field>
      <Field label="New password">
        <PasswordInput
          visible={showPasswords}
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          autoComplete="new-password"
        />
      </Field>
      <PasswordStrengthHint password={newPassword} />
      <Field label="New password again">
        <PasswordInput
          visible={showPasswords}
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          autoComplete="new-password"
        />
      </Field>
      <ShowPasswords checked={showPasswords} onChange={setShowPasswords} />
      {error !== null && <Notice>{error}</Notice>}
      {done && <Notice kind="ok">Password changed.</Notice>}
      <button type="submit" className="primary" disabled={busy}>
        {busy ? 'Saving…' : 'Change password'}
      </button>
    </form>
  );
}

function AuthenticatorForm() {
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [code, setCode] = useState('');
  const [enrolment, setEnrolment] = useState<TotpEnrolmentView | null>(null);
  const [newCode, setNewCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function start(event: FormEvent) {
    event.preventDefault();
    const problem = password.length === 0 ? 'Enter your current password.' : validateCode(code);
    setDone(false);
    if (problem !== null) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setEnrolment(
        await api<TotpEnrolmentView>('/admin/me/totp', {
          method: 'POST',
          body: { password, code: code.trim() },
        }),
      );
      setPassword('');
    } catch (e) {
      setError(describeError(e));
    } finally {
      setCode('');
      setBusy(false);
    }
  }

  async function confirm(event: FormEvent) {
    event.preventDefault();
    const problem = validateCode(newCode);
    if (problem !== null) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api('/admin/me/totp/confirm', { method: 'POST', body: { code: newCode.trim() } });
      setEnrolment(null);
      setDone(true);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setNewCode('');
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-label="Authenticator app">
      <h2>Authenticator app</h2>
      {enrolment === null ? (
        <form method="post" onSubmit={start} autoComplete="off">
          <p className="muted small">
            Move sign-in to a new secret only you hold. The current one keeps working until you
            confirm the new one.
          </p>
          <Field label="Current password">
            <PasswordInput
              visible={showPassword}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </Field>
          <ShowPasswords checked={showPassword} onChange={setShowPassword} />
          <Field label="Current authenticator code">
            <input
              inputMode="numeric"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoComplete="one-time-code"
            />
          </Field>
          <button type="submit" disabled={busy}>
            {busy ? 'Starting…' : 'Set up a new authenticator'}
          </button>
        </form>
      ) : (
        <form method="post" onSubmit={confirm} autoComplete="off">
          <p>
            Add this secret to your authenticator app (type it in, or open the link on the phone),
            then enter the code it shows. It expires in 10 minutes.
          </p>
          <p>
            <code data-testid="new-totp-secret">{enrolment.secret}</code>
          </p>
          <p className="small">
            <a href={enrolment.uri}>Open in authenticator app</a>
          </p>
          <Field label="Code from the new secret">
            <input
              inputMode="numeric"
              maxLength={6}
              value={newCode}
              onChange={(e) => setNewCode(e.target.value)}
              autoComplete="one-time-code"
            />
          </Field>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'Confirming…' : 'Confirm new authenticator'}
          </button>
        </form>
      )}
      {error !== null && <Notice>{error}</Notice>}
      {done && (
        <Notice kind="ok">Authenticator changed. Your other sessions are signed out.</Notice>
      )}
    </section>
  );
}

/**
 * Where the account is signed in now; ending one other session or all of
 * them takes the password and a code (ASVS 3.3.4).
 */
function SessionsCard() {
  const sessions = useFetch<StaffOwnSessionsResponse>('/admin/me/sessions');
  // undefined: no confirmation open; null: every other session; a string: that session.
  const [target, setTarget] = useState<string | null | undefined>(undefined);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function choose(next: string | null | undefined) {
    setTarget(next);
    setError(null);
    setDone(null);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const problem = password.length === 0 ? 'Enter your current password.' : validateCode(code);
    if (problem !== null) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api<RevokeOwnStaffSessionsResponse>('/admin/me/sessions/revoke', {
        method: 'POST',
        body: {
          password,
          code: code.trim(),
          ...(typeof target === 'string' ? { sessionId: target } : {}),
        },
      });
      setDone(
        result.revoked === 1 ? '1 session signed out.' : `${result.revoked} sessions signed out.`,
      );
      setTarget(undefined);
      setPassword('');
      sessions.reload();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setCode('');
      setBusy(false);
    }
  }

  const items = sessions.data?.items ?? [];
  const others = items.filter((item) => !item.current).length;
  return (
    <section className="card" aria-label="Signed-in sessions">
      <h2>Signed-in sessions</h2>
      <p className="muted small">
        Where your account is signed in now. Sign out any session you do not recognise, then change
        your password.
      </p>
      <Loading loading={sessions.loading} error={sessions.error} />
      {items.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Device</th>
              <th>Address</th>
              <th>Signed in</th>
              <th>Last active</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>
                  {deviceLabel(item.userAgent)}{' '}
                  {item.current && <span className="badge good">this session</span>}
                </td>
                <td>{item.ip ?? '–'}</td>
                <td>{formatDateTime(item.createdAt)}</td>
                <td>{formatDateTime(item.lastSeenAt)}</td>
                <td>
                  {!item.current && (
                    <button type="button" onClick={() => choose(item.id)}>
                      Sign out
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {others > 1 && target === undefined && (
        <p>
          <button type="button" onClick={() => choose(null)}>
            Sign out all other sessions
          </button>
        </p>
      )}
      {target !== undefined && (
        <form method="post" onSubmit={submit} autoComplete="off" aria-label="Confirm sign-out">
          <p className="small">
            {target === null ? 'Sign out every other session.' : 'Sign out the chosen session.'}{' '}
            Confirm with your password and a code.
          </p>
          <Field label="Current password">
            <PasswordInput
              visible={showPassword}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </Field>
          <ShowPasswords checked={showPassword} onChange={setShowPassword} />
          <Field label="Authenticator code">
            <input
              inputMode="numeric"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoComplete="one-time-code"
            />
          </Field>
          <div className="row">
            <button type="submit" className="primary" disabled={busy}>
              {busy ? 'Signing out…' : 'Sign out'}
            </button>
            <button type="button" onClick={() => choose(undefined)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {error !== null && <Notice>{error}</Notice>}
      {done !== null && <Notice kind="ok">{done}</Notice>}
    </section>
  );
}
