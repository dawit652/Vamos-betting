'use client';

import {
  StaffAssignableRoleSchema,
  type CashierShopListResponse,
  type CashierStaffListResponse,
  type StaffUserView,
  type TotpEnrolmentView,
} from '@vamos/contracts';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useFetch } from '@/components/hooks';
import { StaffSecret } from '@/components/staff-secret';
import {
  ActionButton,
  Badge,
  DefList,
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
import { localPhone, sortShops } from '@/lib/agents';
import { formatDateTime } from '@/lib/format';
import { isLocked, staffStatus } from '@/lib/staff';

/** A small form with a Save button that reports its API error inline. */
function SaveForm({
  label,
  action,
  children,
  note,
}: {
  label: string;
  action: () => Promise<void>;
  children: ReactNode;
  note?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await action();
      setSaved(true);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="row" aria-label={label} autoComplete="off" onSubmit={submit}>
      {children}
      <button type="submit" disabled={busy}>
        Save
      </button>
      {note !== undefined && <span className="small muted">{note}</span>}
      {saved && <Notice kind="ok">Saved.</Notice>}
      {error !== null && <Notice>{error}</Notice>}
    </form>
  );
}

function Shop({ user }: { user: StaffUserView }) {
  const staff = useFetch<CashierStaffListResponse>('/admin/cashier/staff');
  const shops = useFetch<CashierShopListResponse>('/admin/cashier/shops');
  const [choice, setChoice] = useState<string | null>(null);
  const current = staff.data?.staff.find((s) => s.id === user.id)?.shopId ?? null;
  const value = choice ?? current ?? '';
  return (
    <section className="panel">
      <h2>Shop</h2>
      <Loading loading={staff.loading && staff.data === null} error={staff.error ?? shops.error} />
      {staff.data !== null && shops.data !== null && (
        <SaveForm
          label="Shop"
          action={async () => {
            await api(`/admin/cashier/staff/${user.id}/shop`, {
              method: 'PUT',
              body: { shopId: value === '' ? null : value },
            });
            setChoice(null);
            staff.reload();
          }}
        >
          <Field label="Shop">
            <select value={value} onChange={(e) => setChoice(e.target.value)}>
              <option value="">No shop yet</option>
              {sortShops(shops.data.shops.filter((shop) => shop.active || shop.id === current)).map(
                (shop) => (
                  <option key={shop.id} value={shop.id}>
                    {shop.label} · {shop.agentName} · {shop.name}
                  </option>
                ),
              )}
            </select>
          </Field>
        </SaveForm>
      )}
    </section>
  );
}

export default function StaffDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: user, error, loading, reload } = useFetch<StaffUserView>(`/admin/staff/${id}`);
  const [name, setName] = useState<string | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [phone, setPhone] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [secret, setSecret] = useState<TotpEnrolmentView | null>(null);

  const patch = async (body: { displayName?: string; role?: string; phone?: string | null }) => {
    await api<StaffUserView>(`/admin/staff/${id}`, { method: 'PATCH', body });
    reload();
  };
  const post = async (action: string) => {
    await api(`/admin/staff/${id}/${action}`, { method: 'POST' });
    reload();
  };
  const confirmed = (question: string, action: () => Promise<void>) => async () => {
    if (window.confirm(question)) await action();
  };

  const now = new Date();
  return (
    <>
      <PageHeader title={user === null ? 'Staff account' : user.displayName}>
        <Link href="/staff">Back to staff</Link>
      </PageHeader>
      <Loading loading={loading && user === null} error={error} />
      {secret !== null && user !== null && (
        <StaffSecret
          name={user.displayName}
          generatedPassword={null}
          totp={secret}
          onDone={() => {
            setSecret(null);
            reload();
          }}
        />
      )}
      {user !== null && (
        <>
          <section className="panel">
            <DefList
              rows={[
                ['Name', user.displayName],
                ['Email', user.email],
                ['Role', user.role],
                ['Phone', localPhone(user.phone)],
                ['Status', <Badge key="s" {...badgeOf(user, now)} />],
                [
                  'Authenticator',
                  user.totpEnrolledAt === null
                    ? 'Not yet'
                    : `Enrolled ${formatDateTime(user.totpEnrolledAt)}`,
                ],
                ['Failed sign-ins', String(user.failedLoginAttempts)],
                ['Last sign-in', formatDateTime(user.lastLoginAt)],
                ['Created', formatDateTime(user.createdAt)],
              ]}
            />
          </section>

          <h2>Rename</h2>
          <section className="panel">
            <SaveForm
              label="Rename"
              action={() => patch({ displayName: (name ?? user.displayName).trim() })}
            >
              <Field label="Display name">
                <input
                  required
                  maxLength={100}
                  value={name ?? user.displayName}
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
            </SaveForm>
          </section>

          <h2>Phone</h2>
          <section className="panel">
            <SaveForm
              label="Change phone"
              note="A cashier must keep a phone number."
              action={async () => {
                const value = (phone ?? user.phone ?? '').trim();
                await patch({ phone: value === '' ? null : value });
                setPhone(null);
              }}
            >
              <Field label="Phone">
                <input
                  type="tel"
                  placeholder="09… or 07…"
                  maxLength={32}
                  value={phone ?? user.phone ?? ''}
                  onChange={(e) => setPhone(e.target.value)}
                />
              </Field>
            </SaveForm>
          </section>

          <h2>Role</h2>
          <section className="panel">
            <SaveForm
              label="Change role"
              note="Changing the role signs them out."
              action={() => patch({ role: role ?? user.role })}
            >
              <Field label="Role">
                <select value={role ?? user.role} onChange={(e) => setRole(e.target.value)}>
                  {StaffAssignableRoleSchema.options.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </Field>
            </SaveForm>
          </section>

          {user.role === 'cashier' && <Shop user={user} />}

          <h2>Access</h2>
          <section className="panel">
            <div className="actions">
              {user.disabledAt === null ? (
                <ActionButton
                  label="Disable account"
                  onAction={confirmed(`Disable ${user.displayName}? They are signed out.`, () =>
                    post('disable'),
                  )}
                />
              ) : (
                <ActionButton
                  label="Enable account"
                  primary
                  onAction={confirmed(`Enable ${user.displayName}?`, () => post('enable'))}
                />
              )}
              {(isLocked(user, now) || user.failedLoginAttempts > 0) && (
                <ActionButton label="Unlock" onAction={() => post('unlock')} />
              )}
            </div>
          </section>

          <h2>Reset password</h2>
          <section className="panel">
            <SaveForm
              label="Reset password"
              note="This signs them out. Tell them the new password in person."
              action={async () => {
                if (password.length < 12)
                  throw new Error('A password needs at least 12 characters.');
                await api(`/admin/staff/${id}/reset-password`, {
                  method: 'POST',
                  body: { password },
                });
                setPassword('');
                reload();
              }}
            >
              <Field label="New password">
                <PasswordInput
                  visible={show}
                  minLength={12}
                  maxLength={128}
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>
            </SaveForm>
            <PasswordStrengthHint password={password} />
            <ShowPasswords checked={show} onChange={setShow} />
          </section>

          <h2>Authenticator</h2>
          <section className="panel">
            <ActionButton
              label="Reset authenticator"
              onAction={confirmed(
                `Reset the authenticator of ${user.displayName}? The old one stops working.`,
                async () => {
                  setSecret(
                    await api<TotpEnrolmentView>(`/admin/staff/${id}/reset-totp`, {
                      method: 'POST',
                    }),
                  );
                  reload();
                },
              )}
            />
          </section>
        </>
      )}
    </>
  );
}

function badgeOf(user: StaffUserView, now: Date) {
  const status = staffStatus(user, now);
  return { value: status.text, tone: status.tone };
}
