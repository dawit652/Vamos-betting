'use client';

import {
  STAFF_ROLES,
  type CashierShopListResponse,
  type CreateStaffRequest,
  type CreateStaffResponse,
  type StaffListResponse,
} from '@vamos/contracts';
import Link from 'next/link';
import { useMemo, useState, type FormEvent } from 'react';
import { useFetch } from '@/components/hooks';
import { StaffSecret } from '@/components/staff-secret';
import {
  Badge,
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
import { formatDateTime } from '@/lib/format';
import { filterStaff, sortStaff, staffStatus } from '@/lib/staff';

interface Created {
  response: CreateStaffResponse;
  shopError: string | null;
}

function AddStaff({ onCreated }: { onCreated: (created: Created) => void }) {
  const shops = useFetch<CashierShopListResponse>('/admin/cashier/shops');
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<CreateStaffRequest['role']>('support');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [shopId, setShopId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeShops = (shops.data?.shops ?? []).filter((shop) => shop.active);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (password !== '' && password.length < 12) {
      return setError('A password needs at least 12 characters, or leave it empty.');
    }
    setBusy(true);
    setError(null);
    try {
      const body: CreateStaffRequest = {
        email: email.trim(),
        displayName: displayName.trim(),
        role,
        ...(password === '' ? {} : { password }),
      };
      const response = await api<CreateStaffResponse>('/admin/staff', { method: 'POST', body });
      let shopError: string | null = null;
      if (role === 'cashier' && shopId !== '') {
        try {
          await api(`/admin/cashier/staff/${response.user.id}/shop`, {
            method: 'PUT',
            body: { shopId },
          });
        } catch (e) {
          shopError = describeError(e);
        }
      }
      setEmail('');
      setDisplayName('');
      setPassword('');
      setShopId('');
      onCreated({ response, shopError });
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card" autoComplete="off" aria-label="Add a staff account" onSubmit={submit}>
      <h2>Add a staff account</h2>
      <div className="row">
        <Field label="Email">
          <input
            type="email"
            required
            maxLength={254}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label="Name">
          <input
            required
            maxLength={100}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </Field>
        <Field label="Role">
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as CreateStaffRequest['role'])}
          >
            {STAFF_ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </Field>
        {role === 'cashier' && (
          <Field label="Shop">
            <select value={shopId} onChange={(e) => setShopId(e.target.value)}>
              <option value="">No shop yet</option>
              {activeShops.map((shop) => (
                <option key={shop.id} value={shop.id}>
                  {shop.name} ({shop.code})
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Password (optional)">
          <PasswordInput
            visible={show}
            minLength={12}
            maxLength={128}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
      </div>
      <PasswordStrengthHint password={password} />
      <p className="small muted">
        Leave empty to generate one. A generated password must be changed at the first sign-in,
        within 72 hours.
      </p>
      <ShowPasswords checked={show} onChange={setShow} />
      {error !== null && <Notice>{error}</Notice>}
      <p>
        <button type="submit" className="primary" disabled={busy}>
          Add account
        </button>
      </p>
    </form>
  );
}

export default function StaffPage() {
  const { data, error, loading, reload } = useFetch<StaffListResponse>('/admin/staff');
  const [created, setCreated] = useState<Created | null>(null);
  const [role, setRole] = useState('');
  const [text, setText] = useState('');
  const now = new Date();
  const rows = useMemo(
    () => sortStaff(filterStaff(data?.items ?? [], role, text)),
    [data, role, text],
  );

  return (
    <>
      <PageHeader title="Staff" />
      {created !== null && (
        <>
          <StaffSecret
            name={created.response.user.displayName}
            generatedPassword={created.response.generatedPassword}
            totp={created.response.totp}
            onDone={() => {
              setCreated(null);
              reload();
            }}
          />
          {created.shopError !== null && (
            <Notice>
              The account was created, but the shop could not be set: {created.shopError} Set the
              shop on the account page.
            </Notice>
          )}
        </>
      )}
      <div className="row">
        <Field label="Filter by role">
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="">All roles</option>
            {STAFF_ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Search name or email">
          <input value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
      </div>
      <Loading loading={loading && data === null} error={error} />
      {data !== null && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Status</th>
                <th>Authenticator</th>
                <th>Last sign-in</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => {
                const status = staffStatus(u, now);
                return (
                  <tr key={u.id}>
                    <td>
                      <Link href={`/staff/${u.id}`}>{u.displayName}</Link>
                    </td>
                    <td>{u.email}</td>
                    <td>{u.role}</td>
                    <td>
                      <Badge value={status.text} tone={status.tone} />
                    </td>
                    <td>
                      {u.totpEnrolledAt === null
                        ? 'Not yet'
                        : `Enrolled ${formatDateTime(u.totpEnrolledAt)}`}
                    </td>
                    <td>{formatDateTime(u.lastLoginAt)}</td>
                    <td>{formatDateTime(u.createdAt)}</td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="muted">
                    No staff accounts match.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <AddStaff
        onCreated={(c) => {
          setCreated(c);
          reload();
        }}
      />
    </>
  );
}
