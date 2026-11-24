'use client';

import type { TotpEnrolmentView } from '@vamos/contracts';
import { useState } from 'react';
import { groupSecret } from '@/lib/staff';

function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <button
      type="button"
      aria-label={label}
      onClick={() => {
        void (async () => {
          try {
            await navigator.clipboard.writeText(text);
            setState('copied');
          } catch {
            setState('failed');
          }
        })();
      }}
    >
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy'}
    </button>
  );
}

/**
 * The one-time panel after a staff account is created or its authenticator is reset. The values
 * live only in the parent's React state: never stored, never logged. `onDone` clears them.
 */
export function StaffSecret({
  name,
  generatedPassword,
  totp,
  onDone,
}: {
  name: string;
  generatedPassword: string | null;
  totp: TotpEnrolmentView;
  onDone: () => void;
}) {
  return (
    <section className="panel" data-testid="staff-secret" aria-label="One-time credentials">
      <h2>Give these to {name} in person. They are shown only once.</h2>
      {generatedPassword !== null && (
        <p>
          Password <code data-testid="staff-generated-password">{generatedPassword}</code>{' '}
          <CopyButton text={generatedPassword} label="Copy password" />
        </p>
      )}
      <p>
        Authenticator secret{' '}
        <code data-testid="staff-totp-secret" style={{ fontFamily: 'monospace' }}>
          {groupSecret(totp.secret)}
        </code>{' '}
        <CopyButton text={totp.secret} label="Copy secret" />
      </p>
      <p>
        Setup link <code data-testid="staff-totp-uri">{totp.uri}</code>{' '}
        <CopyButton text={totp.uri} label="Copy setup link" />
      </p>
      <p className="small muted">
        In Google Authenticator or Microsoft Authenticator: Add → Enter a setup key → type the
        secret, time based.
      </p>
      <button type="button" className="primary" onClick={onDone}>
        Done
      </button>
    </section>
  );
}
