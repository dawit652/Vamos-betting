'use client';

import type { ShopDeviceAskRequest, ShopDeviceAskResponse } from '@vamos/contracts';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { ApiClientError, describeError } from '@/lib/errors';
import { TEXT } from '@/lib/text';

export default function RegisterDevicePage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const body: ShopDeviceAskRequest = { email, password, label };
    try {
      await api<ShopDeviceAskResponse>('/shop/devices/request', { method: 'POST', body });
      setDone(true);
      setPassword('');
    } catch (e) {
      setError(
        e instanceof ApiClientError && e.status === 401
          ? TEXT.registerErrors.invalid_credentials!
          : describeError(e, TEXT.registerErrors),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h1>{TEXT.registerTitle}</h1>
      {done ? (
        <p className="notice" role="status">
          {TEXT.registerDone}
        </p>
      ) : (
        <form method="post" onSubmit={(e) => void submit(e)} aria-label="Register this device">
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
          <label htmlFor="label">
            {TEXT.deviceName}
            <input
              id="label"
              type="text"
              maxLength={60}
              required
              placeholder={TEXT.deviceNamePlaceholder}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </label>
          {error === null ? null : (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="primary" disabled={busy}>
            {busy ? TEXT.registerSending : TEXT.registerButton}
          </button>
        </form>
      )}
      <p>
        <Link href="/login">{TEXT.backToSignIn}</Link>
      </p>
    </div>
  );
}
